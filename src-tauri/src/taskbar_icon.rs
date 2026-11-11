//! Windows 任务栏颜色独立于应用主题；图标及消息监听均由窗口线程持有。
use std::{io, mem, ptr};

const DEFAULT_ICON: u16 = 32512;
const LIGHT_TASKBAR_ICON: u16 = 32513;
const SUBCLASS_ID: usize = 0x52544c49;
const WM_SETICON: u32 = 0x0080;
const WM_SETTINGCHANGE: u32 = 0x001a;
const WM_THEMECHANGED: u32 = 0x031a;
const WM_DPICHANGED: u32 = 0x02e0;
const WM_NCDESTROY: u32 = 0x0082;

type SubclassProc = unsafe extern "system" fn(isize, u32, usize, isize, usize, usize) -> isize;

#[link(name = "comctl32")]
extern "system" {
    fn SetWindowSubclass(hwnd: isize, callback: SubclassProc, id: usize, data: usize) -> i32;
    fn GetWindowSubclass(hwnd: isize, callback: SubclassProc, id: usize, data: *mut usize) -> i32;
    fn RemoveWindowSubclass(hwnd: isize, callback: SubclassProc, id: usize) -> i32;
    fn DefSubclassProc(hwnd: isize, message: u32, wparam: usize, lparam: isize) -> isize;
}

#[link(name = "user32")]
extern "system" {
    fn LoadImageW(module: isize, name: *const u16, kind: u32, width: i32, height: i32, flags: u32) -> isize;
    fn DestroyIcon(icon: isize) -> i32;
    fn SendMessageW(hwnd: isize, message: u32, wparam: usize, lparam: isize) -> isize;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> isize;
}

#[link(name = "advapi32")]
extern "system" {
    fn RegGetValueW(key: isize, subkey: *const u16, value: *const u16, flags: u32,
        kind: *mut u32, data: *mut u32, size: *mut u32) -> i32;
}

fn system_uses_light_theme() -> Option<bool> {
    let key: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0".encode_utf16().collect();
    let name: Vec<u16> = "SystemUsesLightTheme\0".encode_utf16().collect();
    let mut value = 0u32;
    let mut size = mem::size_of::<u32>() as u32;
    // HKCU，限定 REG_DWORD；仅查询，不改变系统设置。
    let status = unsafe {
        RegGetValueW(0x80000001u32 as i32 as isize, key.as_ptr(), name.as_ptr(), 0x10,
            ptr::null_mut(), &mut value, &mut size)
    };
    match (status, value) {
        (0, 0) => Some(false),
        (0, 1) => Some(true),
        _ => None,
    }
}

fn resource_for_theme(light: Option<bool>) -> u16 {
    if light == Some(true) { LIGHT_TASKBAR_ICON } else { DEFAULT_ICON }
}

struct Icon(isize);

impl Icon {
    fn load(resource: u16, pixels: i32) -> io::Result<Self> {
        // flags = 0：返回本组件独占的 HICON，替换或销毁时释放。
        let handle = unsafe { LoadImageW(GetModuleHandleW(ptr::null()), resource as usize as *const u16, 1, pixels, pixels, 0) };
        if handle == 0 { Err(io::Error::last_os_error()) } else { Ok(Self(handle)) }
    }
}

impl Drop for Icon {
    fn drop(&mut self) { unsafe { DestroyIcon(self.0); } }
}

struct State {
    resource: u16,
    dpi: u32,
    icons: Option<(Icon, Icon)>,
}

impl State {
    fn refresh(&mut self, hwnd: isize, light: Option<bool>, dpi: u32) -> io::Result<()> {
        let resource = resource_for_theme(light);
        let dpi = dpi.clamp(48, 768);
        if self.icons.is_some() && self.resource == resource && self.dpi == dpi {
            return Ok(());
        }
        // 两枚都加载成功后才替换；失败保留旧图标，避免窗口引用已释放句柄。
        let small = Icon::load(resource, (16 * dpi / 96) as i32)?;
        let large = Icon::load(resource, (32 * dpi / 96) as i32)?;
        unsafe {
            SendMessageW(hwnd, WM_SETICON, 0, small.0);
            SendMessageW(hwnd, WM_SETICON, 1, large.0);
        }
        self.icons = Some((small, large));
        self.resource = resource;
        self.dpi = dpi;
        Ok(())
    }
}

unsafe extern "system" fn window_message(hwnd: isize, message: u32, wparam: usize, lparam: isize, _id: usize, data: usize) -> isize {
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, window_message, SUBCLASS_ID);
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        drop(Box::from_raw(data as *mut State));
        return result;
    }
    if matches!(message, WM_SETTINGCHANGE | WM_THEMECHANGED | WM_DPICHANGED) {
        let state = &mut *(data as *mut State);
        let dpi = if message == WM_DPICHANGED { (wparam & 0xffff) as u32 } else { state.dpi };
        if let Err(error) = state.refresh(hwnd, system_uses_light_theme(), dpi) {
            eprintln!("refresh taskbar icon: {error}");
        }
    }
    // WM_SETICON 的同步重入不访问 State。
    DefSubclassProc(hwnd, message, wparam, lparam)
}

/// 必须在拥有 hwnd 的线程调用；窗口销毁通知负责释放状态，无后台任务。
pub fn install(hwnd: isize, dpi: u32) -> io::Result<()> {
    unsafe {
        let mut existing = 0;
        if GetWindowSubclass(hwnd, window_message, SUBCLASS_ID, &mut existing) != 0 {
            return Ok(());
        }
        let state = Box::into_raw(Box::new(State { resource: 0, dpi, icons: None }));
        if SetWindowSubclass(hwnd, window_message, SUBCLASS_ID, state as usize) == 0 {
            drop(Box::from_raw(state));
            return Err(io::Error::other("install taskbar icon listener failed"));
        }
        if let Err(error) = (*state).refresh(hwnd, system_uses_light_theme(), dpi) {
            RemoveWindowSubclass(hwnd, window_message, SUBCLASS_ID);
            drop(Box::from_raw(state));
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[repr(C)]
    #[derive(Default)]
    struct IconInfo { icon: i32, x: u32, y: u32, mask: isize, color: isize }

    #[repr(C)]
    #[derive(Default)]
    struct Bitmap { kind: i32, width: i32, height: i32, stride: i32, planes: u16, bits: u16, data: isize }

    #[link(name = "user32")]
    extern "system" {
        fn CreateWindowExW(ex: u32, class: *const u16, title: *const u16, style: u32,
            x: i32, y: i32, width: i32, height: i32, parent: isize, menu: isize, module: isize, param: isize) -> isize;
        fn DestroyWindow(hwnd: isize) -> i32;
        fn GetIconInfo(icon: isize, info: *mut IconInfo) -> i32;
    }
    #[link(name = "gdi32")]
    extern "system" {
        fn DeleteObject(object: isize) -> i32;
        fn GetObjectW(object: isize, size: i32, data: *mut Bitmap) -> i32;
    }

    fn icon_size(icon: isize) -> Option<(i32, i32)> {
        let mut info = IconInfo::default();
        let alive = unsafe { GetIconInfo(icon, &mut info) } != 0;
        let mut bitmap = Bitmap::default();
        let read = alive && unsafe { GetObjectW(info.color, mem::size_of::<Bitmap>() as i32, &mut bitmap) } != 0;
        unsafe {
            if info.mask != 0 { DeleteObject(info.mask); }
            if info.color != 0 { DeleteObject(info.color); }
        }
        if read { Some((bitmap.width, bitmap.height)) } else { None }
    }

    struct Window(isize);
    impl Window {
        fn new() -> Self {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let hwnd = unsafe { CreateWindowExW(0, class.as_ptr(), ptr::null(), 0, 0, 0, 32, 32, 0, 0, 0, 0) };
            assert_ne!(hwnd, 0);
            Self(hwnd)
        }
    }
    impl Drop for Window {
        fn drop(&mut self) { unsafe { DestroyWindow(self.0); } }
    }

    #[test]
    fn missing_or_dark_system_theme_uses_readable_default() {
        assert_eq!(resource_for_theme(None), DEFAULT_ICON);
        assert_eq!(resource_for_theme(Some(false)), DEFAULT_ICON);
        assert_eq!(resource_for_theme(Some(true)), LIGHT_TASKBAR_ICON);
    }

    #[test]
    fn embedded_icons_keep_transparency_and_contrast_at_every_shipped_size() {
        for resource in [DEFAULT_ICON, LIGHT_TASKBAR_ICON] {
            for size in [16, 24, 32, 48, 64, 128, 256] {
                let image = tauri::image::Image::from_icon_resource(resource, size, size).unwrap();
                assert_eq!((image.width(), image.height()), (size, size));
                let pixels = image.rgba();
                assert_eq!(pixels[3], 0, "transparent corner: {resource}/{size}");
                assert!(pixels.chunks_exact(4).any(|p| p[3] > 64 && p[0] < 128 && p[1] < 128 && p[2] < 128),
                    "dark contour or glyph: {resource}/{size}");
                assert!(pixels.chunks_exact(4).any(|p| p[3] > 64 && p[0] > 200 && p[1] > 200 && p[2] > 200),
                    "light contour or glyph: {resource}/{size}");
            }
        }
    }

    #[test]
    fn native_window_switches_both_icons_handles_notifications_and_releases_handles() {
        let window = Window::new();
        install(window.0, 96).unwrap();
        let mut data = 0;
        assert_ne!(unsafe { GetWindowSubclass(window.0, window_message, SUBCLASS_ID, &mut data) }, 0);
        install(window.0, 96).unwrap(); // 重复安装不能替换状态或遗留监听。
        let mut again = 0;
        unsafe { GetWindowSubclass(window.0, window_message, SUBCLASS_ID, &mut again); }
        assert_eq!(data, again);
        unsafe {
            let state = &mut *(data as *mut State);
            state.refresh(window.0, Some(false), 96).unwrap();
            let old = state.icons.as_ref().unwrap().0.0;
            state.refresh(window.0, Some(true), 144).unwrap();
            assert!(icon_size(old).is_none());
            assert_eq!(state.resource, LIGHT_TASKBAR_ICON);
            let icons = state.icons.as_ref().unwrap();
            assert_eq!(SendMessageW(window.0, 0x007f, 0, 0), icons.0.0);
            assert_eq!(SendMessageW(window.0, 0x007f, 1, 0), icons.1.0);
            assert_eq!(icon_size(icons.0.0), Some((24, 24)));
            assert_eq!(icon_size(icons.1.0), Some((48, 48)));
            // 走实际子类消息回调；不修改当前系统的主题设置。
            SendMessageW(window.0, WM_SETTINGCHANGE, 0, 0);
            assert_eq!((*(data as *const State)).resource, resource_for_theme(system_uses_light_theme()));
            SendMessageW(window.0, WM_DPICHANGED, 192 | (192 << 16), 0);
            let state = &*(data as *const State);
            assert_eq!(state.dpi, 192);
            let icons = state.icons.as_ref().unwrap();
            let handles = (icons.0.0, icons.1.0);
            assert_eq!(icon_size(handles.0), Some((32, 32)));
            assert_eq!(icon_size(handles.1), Some((64, 64)));
            drop(window);
            assert!(icon_size(handles.0).is_none() && icon_size(handles.1).is_none());
        }
    }

    #[test]
    fn invalid_window_and_missing_resource_return_errors() {
        assert!(install(0, 96).is_err());
        assert!(Icon::load(1, 32).is_err());
    }
}

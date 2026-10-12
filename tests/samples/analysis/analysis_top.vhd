library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity analysis_top is
  port (
    clk, rst_n : in std_logic;
    enable : in std_logic_vector(3 downto 0);
    data_in : in std_logic_vector(7 downto 0);
    address : in integer range 0 to 3;
    data_out : out std_logic_vector(7 downto 0)
  );
end entity;

architecture rtl of analysis_top is
  type rom_type is array (0 to 3) of std_logic_vector(7 downto 0);
  signal ROM : rom_type := (x"12", x"34", x"56", x"78");
  signal lane_valid : std_logic_vector(3 downto 0);
  signal lane_seen : std_logic_vector(3 downto 0);
  signal selected_data : std_logic_vector(7 downto 0);
begin
  process(clk, rst_n) begin
    if rst_n = '0' then
      lane_valid <= (others => '0');
    elsif rising_edge(clk) then
      if enable(0) = '1' then lane_valid(0) <= data_in(0); else lane_valid(0) <= '0'; end if;
      if enable(1) = '1' then lane_valid(1) <= data_in(1); else lane_valid(1) <= '0'; end if;
      if enable(2) = '1' then lane_valid(2) <= data_in(2); else lane_valid(2) <= '0'; end if;
      if enable(3) = '1' then lane_valid(3) <= data_in(3); else lane_valid(3) <= '0'; end if;
    end if;
  end process;

  lanes : for i in 0 to 3 generate
    receiver : entity work.analysis_leaf
      port map(clk => clk, valid => lane_valid(i), seen => lane_seen(i));
  end generate;

  selected_data <= ROM(address);
  data_out <= std_logic_vector(resize(unsigned(selected_data), 8));
end architecture;

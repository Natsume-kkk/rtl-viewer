library ieee;
use ieee.std_logic_1164.all;

entity sample_register is
    port (
        clk : in std_logic;
        reset_n : in std_logic;
        data_in : in std_logic;
        data_out : out std_logic
    );
end entity;

architecture rtl of sample_register is
begin
    process(clk, reset_n)
    begin
        if reset_n = '0' then
            data_out <= '0';
        elsif rising_edge(clk) then
            data_out <= data_in;
        end if;
    end process;
end architecture;

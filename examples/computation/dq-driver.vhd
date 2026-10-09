library ieee;
use ieee.std_logic_1164.all;

entity dq_driver is
    port (
        i_clk, i_rst_n, i_dq_in : in std_logic;
        o_dq_out, o_dq_out_en, o_ack : out std_logic
    );
end entity;

architecture rtl of dq_driver is
    signal s_slave_ack : std_logic;
begin
    o_dq_out <= '0';
    o_dq_out_en <= '0' when i_rst_n = '1' else '1';
    o_ack <= s_slave_ack;

    process(i_clk, i_rst_n)
    begin
        if i_rst_n = '0' then
            s_slave_ack <= '1';
        elsif rising_edge(i_clk) then
            s_slave_ack <= i_dq_in;
        end if;
    end process;
end architecture;

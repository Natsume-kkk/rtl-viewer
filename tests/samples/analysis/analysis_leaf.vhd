library ieee;
use ieee.std_logic_1164.all;

entity analysis_leaf is
  port(clk, valid : in std_logic; seen : out std_logic);
end entity;

architecture rtl of analysis_leaf is
begin
  process(clk) begin
    if rising_edge(clk) then
      seen <= valid;
    end if;
  end process;
end architecture;

// 独立编写的解析验收样例，不用于综合或板卡交付。
module sample_top (
    input wire clk,
    input wire reset_n,
    input wire data_in,
    output wire data_out
);
    wire buffered_clk;
    sample_clock u_clock (.clk_in(clk), .clk_out(buffered_clk));
    sample_register u_register (
        .clk(buffered_clk), .reset_n(reset_n),
        .data_in(data_in), .data_out(data_out)
    );
endmodule

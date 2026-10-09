// Minimal mixed-language example. The actual project can be included by build.mjs.
module temp_top (
    input wire clk,
    input wire rst_n,
    inout wire dq_1,
    output wire ack
);
    wire dq_in_1;
    wire dq_out_1;
    wire dq_out_en_1;
    assign dq_1 = dq_out_en_1 ? dq_out_1 : 1'bz;
    assign dq_in_1 = dq_1;
    dq_driver u_ds18b20_driver1 (
        .i_clk(clk),
        .i_rst_n(rst_n),
        .i_dq_in(dq_in_1),
        .o_dq_out(dq_out_1),
        .o_dq_out_en(dq_out_en_1),
        .o_ack(ack)
    );
endmodule

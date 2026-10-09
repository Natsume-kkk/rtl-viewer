module signal_example (
    input wire clk,
    input wire rst_n,
    input wire en,
    input wire [7:0] data_in,
    input wire [7:0] offset,
    input wire [7:0] gain,
    output wire [7:0] out
);
    wire [8:0] sum = {1'b0, data_in} + {1'b0, offset};
    wire [16:0] product = sum * gain;
    reg [16:0] result;

    always @(posedge clk) begin
        if (!rst_n)
            result <= 17'd0;
        else if (en)
            result <= product;
    end

    assign out = (result > 17'd255) ? 8'd255 : result[7:0];
endmodule

module parameter_top(input [3:0] data, output [3:0] narrow, output [7:0] wide);
  parameter_leaf #(.WIDTH(4)) u_narrow(.din(data), .dout(narrow));
  parameter_leaf #(.WIDTH(8)) u_wide(.din({4'b0000, data}), .dout(wide));
endmodule

module parameter_leaf #(parameter WIDTH = 4)(input [WIDTH-1:0] din, output [WIDTH-1:0] dout);
  genvar i;
  generate
    for (i = 0; i < WIDTH; i = i + 1) begin : bits
      assign dout[i] = din[i];
    end
  endgenerate
endmodule

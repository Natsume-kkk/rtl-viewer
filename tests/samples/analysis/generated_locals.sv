module generated_locals (
  input logic a,
  input logic b,
  output wire [1:0] y
);
  for (genvar i = 0; i < 2; i++) begin : lanes
    wire w;
    assign w = i ? a : b;
    assign y[i] = w;
  end
endmodule

// Shift register bank: a public test design with many flop-to-flop paths.
module shreg #(parameter CHAINS = 24, parameter LEN = 500) (
    input  wire              clk,
    input  wire [CHAINS-1:0] d,
    output wire [CHAINS-1:0] q
);
    genvar i;
    generate
        for (i = 0; i < CHAINS; i = i + 1) begin : g
            reg [LEN-1:0] r;
            always @(posedge clk) r <= {r[LEN-2:0], d[i]};
            assign q[i] = r[LEN-1];
        end
    endgenerate
endmodule

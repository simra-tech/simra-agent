// Shift register bank with a registered enable: a public test design.
// One flip-flop (en_q) drives the enable of every other flip-flop: a net with a very high fanout.
module shreg_en #(parameter CHAINS = 24, parameter LEN = 500) (
    input  wire              clk,
    input  wire              en,
    input  wire [CHAINS-1:0] d,
    output wire [CHAINS-1:0] q
);
    reg en_q;
    always @(posedge clk) en_q <= en;
    genvar i;
    generate
        for (i = 0; i < CHAINS; i = i + 1) begin : g
            reg [LEN-1:0] r;
            always @(posedge clk)
                if (en_q) r <= {r[LEN-2:0], d[i]};
            assign q[i] = r[LEN-1];
        end
    endgenerate
endmodule

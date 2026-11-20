// Small accumulator with a multiplier: a public test design. Revision 2: the output has a register stage.
module acc #(parameter W = 16) (
    input  wire         clk,
    input  wire         rst_n,
    input  wire         en,
    input  wire [W-1:0] a,
    input  wire [W-1:0] b,
    output reg  [2*W-1:0] y
);
    reg [W-1:0] ra, rb;
    reg [2*W-1:0] sum;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            ra <= 0; rb <= 0; sum <= 0; y <= 0;
        end else if (en) begin
            ra <= a; rb <= b;
            sum <= sum + ra * rb;
            y <= sum;
        end
    end
endmodule

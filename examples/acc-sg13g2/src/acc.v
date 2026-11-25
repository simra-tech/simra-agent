// Small accumulator with a multiplier: a public test design.
module acc #(parameter W = 16) (
    input  wire         clk,
    input  wire         rst_n,
    input  wire         en,
    input  wire [W-1:0] a,
    input  wire [W-1:0] b,
    output reg  [2*W-1:0] y
);
    reg [W-1:0] ra, rb;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            ra <= 0; rb <= 0; y <= 0;
        end else if (en) begin
            ra <= a; rb <= b;
            y <= y + ra * rb;
        end
    end
endmodule

// 8-tap FIR filter: a public test design. Revision 2: signed arithmetic, 8 taps.
module fir (
    input  wire               clk,
    input  wire               rst_n,
    input  wire signed [7:0]  x,
    output reg  signed [17:0] y
);
    reg signed [7:0] d0, d1, d2, d3, d4, d5, d6, d7;
    wire signed [17:0] acc = d0 * 8'sd3 + d1 * 8'sd11 + d2 * 8'sd29 + d3 * 8'sd53
                           + d4 * 8'sd53 + d5 * 8'sd29 + d6 * 8'sd11 + d7 * 8'sd3;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            d0 <= 0; d1 <= 0; d2 <= 0; d3 <= 0; d4 <= 0; d5 <= 0; d6 <= 0; d7 <= 0; y <= 0;
        end else begin
            d0 <= x; d1 <= d0; d2 <= d1; d3 <= d2; d4 <= d3; d5 <= d4; d6 <= d5; d7 <= d6; y <= acc;
        end
    end
endmodule

// 4-tap FIR filter: a public test design. Revision 1: unsigned ports, sign extension by hand.
module fir (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [7:0]  x,
    output reg  [17:0] y
);
    reg [7:0] d0, d1, d2, d3;
    wire [17:0] s0 = {{10{d0[7]}}, d0};
    wire [17:0] s1 = {{10{d1[7]}}, d1};
    wire [17:0] s2 = {{10{d2[7]}}, d2};
    wire [17:0] s3 = {{10{d3[7]}}, d3};
    wire [17:0] acc = s0 * 18'd3 + s1 * 18'd11 + s2 * 18'd11 + s3 * 18'd3;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            d0 <= 0; d1 <= 0; d2 <= 0; d3 <= 0; y <= 0;
        end else begin
            d0 <= x; d1 <= d0; d2 <= d1; d3 <= d2; y <= acc;
        end
    end
endmodule

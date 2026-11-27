// A path from a rising-edge flip-flop to a falling-edge flip-flop: a public test design.
// The path has half a clock period.
module halfcycle (
    input  wire       clk,
    input  wire [7:0] a,
    input  wire [7:0] b,
    output reg  [7:0] y
);
    reg [7:0] s;
    always @(posedge clk) s <= a + b;
    always @(negedge clk) y <= s ^ {s[0], s[7:1]};
endmodule

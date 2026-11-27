// A wrapper that uses the public accumulator with a parameter override: a public test design.
module acc_top (
    input  wire        clk,
    input  wire        rst_n,
    input  wire        en,
    input  wire [7:0]  a,
    input  wire [7:0]  b,
    output wire [15:0] y
);
    acc #(.W(8)) u_acc (.clk(clk), .rst_n(rst_n), .en(en), .a(a), .b(b), .y(y));
endmodule

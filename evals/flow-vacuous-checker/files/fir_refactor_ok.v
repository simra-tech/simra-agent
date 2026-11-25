// 4-tap FIR filter: a public test design. The coefficients are in a table.
module fir (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [7:0]  x,
    output reg  [17:0] y
);
    localparam [4*18-1:0] COEFF = {18'd3, 18'd11, 18'd11, 18'd3};
    reg [7:0] d [0:3];
    reg [17:0] acc;
    integer k;
    always @* begin
        acc = 18'd0;
        for (k = 0; k < 4; k = k + 1)
            acc = acc + {{10{d[k][7]}}, d[k]} * COEFF[k*18 +: 18];
    end
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (k = 0; k < 4; k = k + 1) d[k] <= 8'd0;
            y <= 18'd0;
        end else begin
            d[0] <= x;
            for (k = 1; k < 4; k = k + 1) d[k] <= d[k-1];
            y <= acc;
        end
    end
endmodule

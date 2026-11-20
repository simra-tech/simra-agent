// Test bench of the FIR block: one output line for each stimulus word.
`timescale 1ns/1ps
module tb;
    reg clk = 0;
    reg rst_n = 0;
    reg [7:0] x = 0;
    wire [17:0] y;
    reg [7:0] stim [0:4095];
    integer i, f;

    fir dut (.clk(clk), .rst_n(rst_n), .x(x), .y(y));
    always #5 clk = ~clk;

    initial begin
        $readmemh("STIM_PATH", stim);
        f = $fopen("out/result.txt", "w");
        repeat (2) @(posedge clk);
        #1 rst_n = 1;
        // The stimulus ends at the first word that the file does not define.
        for (i = 0; i < 4096 && stim[i] !== 8'hxx; i = i + 1) begin
            x = stim[i];
            @(posedge clk);
            #1 $fdisplay(f, "%05x", y);
        end
        $fclose(f);
        $finish;
    end
endmodule

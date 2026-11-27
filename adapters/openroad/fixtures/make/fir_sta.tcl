read_liberty /work/lib/sg13g2_stdcell_slow_1p08V_125C.lib
read_verilog fir.nl.v
link_design fir
create_clock -name clk -period 5.0 [get_ports clk]
set_input_delay 0.5 -clock clk [get_ports {x[*]}]
set_output_delay 0.5 -clock clk [get_ports {y[*]}]
report_checks -path_delay max -digits 3
report_wns -digits 3
report_tns -digits 3

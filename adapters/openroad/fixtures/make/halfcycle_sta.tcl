# Timing of a half-cycle path. The clock period is 10 ns; the path report shows a rise edge and a fall edge.
read_liberty /work/lib/sg13g2_stdcell_slow_1p08V_125C.lib
read_verilog halfcycle.nl.v
link_design halfcycle
create_clock -name clk -period 10 [get_ports clk]
report_checks -path_delay max -to [get_pins -hierarchical */D] -group_path_count 1 -digits 3
report_wns -digits 3
report_tns -digits 3

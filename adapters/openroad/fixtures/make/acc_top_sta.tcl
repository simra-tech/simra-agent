# Timing of the block acc inside the synthesized netlist, at the slow corner, without wires.
read_liberty /work/lib/sg13g2_stdcell_slow_1p08V_125C.lib
read_verilog acc_top.nl.v
link_design acc
create_clock -name clk -period 7.1 [get_ports clk]
report_checks -path_delay max -digits 3
report_wns -digits 3
report_tns -digits 3

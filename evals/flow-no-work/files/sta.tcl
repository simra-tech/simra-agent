# Setup timing of the synthesized netlist at the slow corner, without wires.
read_liberty /foss/pdks/ihp-sg13g2/libs.ref/sg13g2_stdcell/lib/sg13g2_stdcell_slow_1p08V_125C.lib
read_verilog ../syn/fir.nl.v
link_design fir
create_clock -name clk -period $::env(CLOCK_PERIOD_NS) [get_ports clk]
set_input_delay 0.5 -clock clk [get_ports {x[*]}]
set_output_delay 0.5 -clock clk [get_ports {y[*]}]
report_checks -path_delay max -digits 3 > reports/setup.rpt
report_wns -digits 3 > reports/wns.rpt
report_tns -digits 3 > reports/tns.rpt

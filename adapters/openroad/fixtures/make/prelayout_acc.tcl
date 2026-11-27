read_lef /foss/pdks/ihp-sg13g2/libs.ref/sg13g2_stdcell/lef/sg13g2_tech.lef
read_lef /foss/pdks/ihp-sg13g2/libs.ref/sg13g2_stdcell/lef/sg13g2_stdcell.lef
read_liberty /work/lib/sg13g2_stdcell_slow_1p08V_125C.lib
read_verilog acc.nl.v
link_design acc
create_clock -name clk -period 7.1 [get_ports clk]
set_input_delay 1.42 -clock clk [get_ports {a[*] b[*] en rst_n}]
set_output_delay 1.42 -clock clk [get_ports {y[*]}]
set_max_fanout 20 [current_design]
repair_design
report_checks -path_delay max -digits 3
report_wns -digits 3
report_tns -digits 3
report_worst_slack -max -digits 3
report_check_types -max_slew -max_capacitance -max_fanout -violators

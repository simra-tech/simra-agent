# The same timing as sta_valid.log, with the report in ps (set_cmd_units -time ps).
read_liberty /work/lib/sg13g2_stdcell_slow_1p08V_125C.lib
read_verilog acc.nl.v
link_design acc
set_cmd_units -time ps
report_units
create_clock -name clk -period 7100 [get_ports clk]
report_checks -path_delay max -digits 1
report_wns -digits 1
report_tns -digits 1
report_worst_slack -max -digits 1

# Timing check before the placement: the netlist only, no floorplan, no placement, no wires.
read_lef /foss/pdks/ihp-sg13g2/libs.ref/sg13g2_stdcell/lef/sg13g2_tech.lef
read_lef /foss/pdks/ihp-sg13g2/libs.ref/sg13g2_stdcell/lef/sg13g2_stdcell.lef
read_liberty /work/lib/sg13g2_stdcell_slow_1p08V_125C.lib
read_verilog shreg_en.nl.v
link_design shreg_en
read_sdc shreg_en.sdc
repair_design
report_checks -path_delay max -digits 3
report_wns -digits 3
report_tns -digits 3
report_worst_slack -max -digits 3
report_check_types -max_slew -max_capacitance -max_fanout -violators

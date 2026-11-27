# The extraction of the routed block as the flow does it (step OpenROAD.RCX): layer resistance from the technology LEF
# (extract_parasitics -lef_res), capacitance from the rule file. TECH_LEF is the technology LEF of the PDK, or a copy
# without the RESISTANCE statements. LEF_RES=0 leaves the option -lef_res out.
read_lef $::env(TECH_LEF)
read_lef /foss/pdks/ihp-sg13g2/libs.ref/sg13g2_stdcell/lef/sg13g2_stdcell.lef
read_def runs/full/53-odb-cellfrequencytables/acc.def
define_process_corner -ext_model_index 0 CURRENT_CORNER
if { $::env(LEF_RES) } {
    extract_parasitics -ext_model_file /foss/pdks/ihp-sg13g2/libs.tech/librelane/openrcx/IHP_rcx_patterns.rules -lef_res
} else {
    extract_parasitics -ext_model_file /foss/pdks/ihp-sg13g2/libs.tech/librelane/openrcx/IHP_rcx_patterns.rules
}
write_spef $::env(OUT)

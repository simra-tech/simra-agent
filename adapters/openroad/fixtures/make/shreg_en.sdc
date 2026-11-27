create_clock -name clk -period 10 [get_ports clk]
set_input_delay 2 -clock clk [get_ports {d[*] en}]
set_output_delay 2 -clock clk [get_ports {q[*]}]
set_max_fanout 20 [current_design]

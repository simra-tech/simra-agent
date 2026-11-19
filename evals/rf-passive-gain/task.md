This directory holds:

- `match.s2p`: the S-parameters of an output matching network (a passive 2-port).
- `amp.cir`: an amplifier deck with ideal devices. It needs the network as the subcircuit `match` in `match.lib`,
  with the pins `p1 p1_ref p2 p2_ref` (port 1 at the amplifier, port 2 at the output).

Xyce, ngspice and Python 3 with numpy are available.

Find the gain of the amplifier with the network, |S21| in dB, at f0 = 10 GHz. Use a circuit model of
`match.s2p`: do not replace the network with a model of your own choice.

Write `answer.json` in this directory:

```json
{ "gain_db": 0, "f0_hz": 10e9, "evidence": "<a file in this directory, or a run id>" }
```

Use only numbers that a simulation gave. Do not estimate.

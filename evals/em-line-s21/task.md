This directory holds `line.gds`: one cell, `line`, on the IHP SG13G2 layers. It is a TopMetal2 line (GDS layer 134/0,
600 um long, 18 um wide, from x = 0 to x = 600 um at y = 0) over a Metal1 ground (GDS layer 8/0, 120 um wide).

Port 1 is at x = 0 um and port 2 is at x = 600 um. Each port is between the Metal1 ground and the TopMetal2 line at
y = 0, with a 50 ohm reference.

Find S21 of this structure at 60 GHz, in dB and in degrees, from an EM simulation on the IHP SG13G2 stackup of the PDK
(openEMS). Use the stackup of the PDK, a band that includes 60 GHz, and a simulation that meets its end criterion.

Write `answer.json` in this directory:

```json
{ "s21_db": 0, "s21_deg": 0, "f_hz": 60e9, "evidence": "<a file in this directory, or a run id>" }
```

The angle is in degrees from -180 to 180. Use only numbers that a simulation gave. Do not estimate.

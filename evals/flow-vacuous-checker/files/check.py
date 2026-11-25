"""Compare the simulation output with the golden output, line by line. Usage: check.py <result> <golden>"""
import sys

result = open(sys.argv[1]).read().split()
golden = open(sys.argv[2]).read().split()
mismatches = sum(1 for r, g in zip(result, golden) if r != g)
if mismatches:
    print(f"FAIL: {mismatches} mismatches")
    sys.exit(1)
print("PASS: 0 mismatches")

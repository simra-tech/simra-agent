# Run a program in a terminal (140 x 40) and type into it:
#   python3 terminal.py '[["text to wait for", "keys to send"], ...]' <program> [<arg>...]
# It prints the terminal output. It fails when the program ends, or 30 s pass, before a text appears.
import fcntl, json, os, pty, select, struct, sys, termios, time

pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    os.execv(sys.argv[2], sys.argv[2:])
out = b""


def fail(reason):
    sys.stdout.write(out.decode(errors="replace"))
    sys.exit(reason)


for wait, keys in json.loads(sys.argv[1]):
    end = time.time() + 30
    while wait.encode() not in out:
        if time.time() > end:
            fail("timeout: no " + repr(wait))
        if select.select([fd], [], [], 0.2)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                fail("the program ended before " + repr(wait))
            out += data
    os.write(fd, keys.encode())
os.kill(pid, 9)
sys.stdout.write(out.decode(errors="replace"))

#!/bin/sh
# Install simra, a chip-design agent: https://github.com/simra-tech/simra-agent
#
#   curl -fsSL https://github.com/simra-tech/simra-agent/releases/latest/download/install.sh | sh
#
# It downloads simra @VERSION@ for this machine and checks its SHA-256 hash. It unpacks it to
# $SIMRA_HOME/releases/@VERSION@ (default ~/.local/share/simra) and links ~/.local/bin/simra to it. If ~/.local/bin is
# not on the PATH, it asks before it adds a marked block to your shell profile. It changes nothing else.
# Run it again to update. It keeps the previous release. "simra uninstall" removes simra.
#
#   SIMRA_VERSION=<version>   install that release
#   SIMRA_HOME=<dir>          install to <dir>, for example a scratch disk
#   SIMRA_NO_MODIFY_PATH=1    do not change the shell profile
#   SIMRA_RELEASES_URL=<url>  download from a mirror of the releases page
set -eu

version=@VERSION@
# The SHA-256 hash of each tarball. The release workflow writes them here.
sums='
@SHA256SUMS@
'
releases=${SIMRA_RELEASES_URL:-https://github.com/simra-tech/simra-agent/releases}
home=${SIMRA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/simra}
bin=$HOME/.local/bin
tmp=
locked=

say() { printf 'simra: %s\n' "$*" >&2; }
die() {
	say "$*"
	exit 1
}

# Sets os and platform (for example linux-x64), or stops.
check_machine() {
	[ "$(id -u)" != 0 ] || die "do not install as root. Run the installer as the user who uses simra."
	case $(uname -s) in
	Linux)
		os=linux
		if ldd --version 2>&1 | grep -qi musl; then die "this Linux uses musl libc (for example Alpine). simra needs glibc."; fi
		;;
	Darwin)
		os=darwin
		macos=$(sw_vers -productVersion)
		[ "${macos%%.*}" -ge 13 ] || die "macOS $macos is too old. simra needs macOS 13 or later."
		;;
	*) die "$(uname -s) is not supported. simra runs on Linux and macOS." ;;
	esac
	case $(uname -m) in
	x86_64 | amd64) cpu=x64 ;;
	aarch64 | arm64) cpu=arm64 ;;
	*) die "the CPU $(uname -m) is not supported. simra runs on x64 and arm64." ;;
	esac
	# A shell under Rosetta on an Apple silicon Mac reports x86_64.
	if [ "$os" = darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then cpu=arm64; fi
	platform=$os-$cpu
	command -v curl >/dev/null || command -v wget >/dev/null || die "curl or wget is needed to download simra."
	command -v sha256sum >/dev/null || command -v shasum >/dev/null || command -v openssl >/dev/null ||
		die "sha256sum, shasum or openssl is needed to check the download. Nothing was installed."
	for tool in tar gzip; do command -v "$tool" >/dev/null || die "$tool is needed to unpack simra."; done
}

# Downloads $1 to $2. curl and wget use HTTPS_PROXY and the CAs of the system. If that fails and NODE_EXTRA_CA_CERTS
# names a CA file (simra uses it), they try again with that CA.
fetch() {
	if command -v curl >/dev/null; then
		curl -fsSL --retry 2 -o "$2" "$1" ||
			{ [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && curl -fsSL --retry 2 --cacert "$NODE_EXTRA_CA_CERTS" -o "$2" "$1"; }
	else
		export https_proxy="${https_proxy:-${HTTPS_PROXY:-}}"
		wget -q -O "$2" "$1" ||
			{ [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && wget -q --ca-certificate="$NODE_EXTRA_CA_CERTS" -O "$2" "$1"; }
	fi
}

sha256() {
	if command -v sha256sum >/dev/null; then
		sha256sum "$1" | cut -d' ' -f1
	elif command -v shasum >/dev/null; then
		shasum -a 256 "$1" | cut -d' ' -f1
	else
		openssl dgst -sha256 -r "$1" | cut -d' ' -f1
	fi
}

installed() { [ "$("$home/releases/$version/simra" --version 2>/dev/null)" = "$version" ]; }

# One installer at a time changes releases/ and current. The lock is a folder.
lock() {
	i=0
	until mkdir "$home/.lock" 2>/dev/null; do
		i=$((i + 1))
		[ "$i" -le 60 ] || die "another installer runs in $home. If none runs, remove $home/.lock."
		sleep 1
	done
	locked=$home/.lock
}

# Puts the release in $home/releases/$version, then points $home/current at it in one rename.
install_release() {
	tarball=simra-$platform.tar.gz
	sha=$(printf '%s\n' "$sums" | awk -v f="$tarball" '$2 == f { print $1 }')
	[ -n "$sha" ] || die "this installer has no $tarball."
	mkdir -p "$home/releases"
	if installed; then
		say "simra $version is in $home/releases/$version already."
	else
		# The staging folder is on the same disk, so the move into releases/ is a rename.
		tmp=$(mktemp -d "$home/.staging.XXXXXX")
		say "downloading simra $version for $platform"
		fetch "$releases/download/v$version/$tarball" "$tmp/$tarball"
		[ "$(sha256 "$tmp/$tarball")" = "$sha" ] || die "$tarball has the wrong SHA-256 hash. Nothing was installed."
		tar -xzf "$tmp/$tarball" -C "$tmp"
		[ "$("$tmp/simra/simra" --version 2>/dev/null)" = "$version" ] ||
			die "the new simra does not start on this machine (simra --version). Nothing was installed."
	fi
	lock
	if [ -n "$tmp" ] && ! installed; then
		rm -rf "$home/releases/$version"
		mv "$tmp/simra" "$home/releases/$version"
	fi
	previous=$(readlink "$home/current" 2>/dev/null || true)
	rm -f "$home/current.new"
	ln -s "releases/$version" "$home/current.new"
	if [ "$os" = linux ]; then mv -Tf "$home/current.new" "$home/current"; else mv -hf "$home/current.new" "$home/current"; fi
	# Keep this release and the previous one. A session may still run an older one on another host.
	if [ "$previous" != "releases/$version" ]; then
		for dir in "$home"/releases/*; do
			case $dir in "$home/releases/$version" | "$home/$previous") ;; *) rm -rf "$dir" ;; esac
		done
	fi
	printf '{"version": "%s", "platform": "%s", "sha256": "%s", "installed_at": "%s"}\n' \
		"$version" "$platform" "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$home/receipt.json"
	rmdir "$locked"
	locked=
}

link() {
	mkdir -p "$bin"
	if [ -e "$bin/simra" ] && [ ! -L "$bin/simra" ]; then die "$bin/simra is a file, not a link. Remove it, then run the installer again."; fi
	ln -sfn "$home/current/simra" "$bin/simra"
}

# Adds $bin to the PATH in the shell profile, after a question through the terminal. Without a terminal, with CI or
# SIMRA_NO_MODIFY_PATH=1, or for tcsh and other shells, it prints the line instead.
add_to_path() {
	case ":$PATH:" in *":$bin:"*) return ;; esac
	line="export PATH=\"$bin:\$PATH\""
	case $(basename "${SHELL:-sh}") in
	zsh) profile=${ZDOTDIR:-$HOME}/.zshrc ;;
	bash) if [ "$os" = darwin ]; then profile=$HOME/.bash_profile; else profile=$HOME/.bashrc; fi ;;
	fish) profile=${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish line="set -gx PATH \"$bin\" \$PATH" ;;
	tcsh | csh) profile= line="setenv PATH \"$bin:\$PATH\"" ;;
	*) profile= ;;
	esac
	if [ -n "$profile" ] && grep -q '^# >>> simra >>>$' "$profile" 2>/dev/null; then
		say "$profile adds $bin to the PATH already. Open a new terminal."
		return
	fi
	if [ -z "$profile" ] || [ -n "${CI:-}" ] || [ "${SIMRA_NO_MODIFY_PATH:-}" = 1 ] || ! (: </dev/tty) 2>/dev/null; then
		say "add $bin to the PATH, for example with this line in your shell profile: $line"
		return
	fi
	printf 'simra: add %s to the PATH in %s? [Y/n] ' "$bin" "$profile" >/dev/tty
	read -r answer </dev/tty || answer=n
	case $answer in
	[nN]*) say "add this line to your shell profile: $line" ;;
	*)
		mkdir -p "$(dirname "$profile")"
		printf '\n# >>> simra >>>\n%s\n# <<< simra <<<\n' "$line" >>"$profile"
		say "added $bin to the PATH in $profile. Open a new terminal, or run: $line"
		;;
	esac
}

main() {
	check_machine
	case $home in /*) ;; *) home=$PWD/$home ;; esac
	trap 'rm -rf "$tmp"; [ -z "$locked" ] || rmdir "$locked"' EXIT
	if [ -n "${SIMRA_VERSION:-}" ] && [ "${SIMRA_VERSION#v}" != "$version" ]; then
		# The installer of that release has its hashes.
		tmp=$(mktemp -d)
		fetch "$releases/download/v${SIMRA_VERSION#v}/install.sh" "$tmp/install.sh"
		sh "$tmp/install.sh"
		return
	fi
	install_release
	link
	add_to_path
	say "installed simra $version. Run simra to start."
}

main

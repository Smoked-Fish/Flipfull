#!/system/bin/sh
D=${1:-30}
ticks() {
  t=0; for p in "$@"; do [ -r /proc/$p/stat ] && t=$((t + $(awk '{print $14+$15}' /proc/$p/stat))); done; echo $t; }
b2g=$(pidof b2g | tr ' ' '\n' | while read p; do grep -q "true tab" /proc/$p/cmdline 2>/dev/null || echo $p; done | tr '\n' ' ')
tabs=$(pgrep -f "true tab" | tr '\n' ' ')
hwc=$(pidof vendor.qti.hardware.display.composer-service)
logd=$(pidof logd)
kth=$(ps -A -o PID,NAME | grep -E "crtc_commit|kgsl_dispatcher|spi_kickoff|spi_fake_vsync|sde_" | awk '{print $1}' | tr '\n' ' ')
all_idle1=$(awk '/^cpu /{print $5}' /proc/stat); all_tot1=$(awk '/^cpu /{s=0;for(i=2;i<=NF;i++)s+=$i;print s}' /proc/stat)
a1=$(ticks $b2g); b1=$(ticks $tabs); c1=$(ticks $hwc); d1=$(ticks $logd); e1=$(ticks $kth)
logcat -c; sleep $D
n=$(logcat -d | grep -cE " (SDM|FramebufferSurface)")
a2=$(ticks $b2g); b2=$(ticks $tabs); c2=$(ticks $hwc); d2=$(ticks $logd); e2=$(ticks $kth)
all_idle2=$(awk '/^cpu /{print $5}' /proc/stat); all_tot2=$(awk '/^cpu /{s=0;for(i=2;i<=NF;i++)s+=$i;print s}' /proc/stat)
pct() { awk -v t=$1 -v d=$D 'BEGIN{printf "%5.1f%%", t/d}'; }
echo "b2g main       $(pct $((a2-a1)))"
echo "b2g app procs  $(pct $((b2-b1)))  (8 tabs incl. foreground app)"
echo "HW composer    $(pct $((c2-c1)))"
echo "display kthrds $(pct $((e2-e1)))"
echo "logd           $(pct $((d2-d1)))"
echo "SDM/FBSurface log lines/s: $(awk -v n=$n -v d=$D 'BEGIN{printf "%.1f", n/d}')"
awk -v i=$((all_idle2-all_idle1)) -v t=$((all_tot2-all_tot1)) 'BEGIN{printf "whole system busy: %.1f%% of 8 cores\n", 100*(1-i/t)}'
echo "backlight=$(cat /sys/class/backlight/panel0-backlight/brightness) battery=$(cat /sys/class/power_supply/battery/status)"

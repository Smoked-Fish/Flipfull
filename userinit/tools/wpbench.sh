#!/system/bin/sh
OUT=/data/local/tmp/wpbench.csv
HDR="label,secs,awake_pct,suspends,b2g_main,b2g_tabs,hwcodec,swcodec,composer,disp_kthr,sys_busy_8c,pss_b2g_mb,pss_tabs_mb,pss_hwcodec_mb,pss_swcodec_mb,gpu_b2g_mb,dmabuf_mb,memavail_mb,dsi,spi,usb"

if [ "$1" = summary ]; then
  [ -r $OUT ] || { echo "no $OUT yet"; exit 1; }
  awk -F, 'NR==1{for(i=1;i<=NF;i++)h[i]=$i; nf=NF; next}
    {l=$1; if(!(l in n)) ord[++k]=l; n[l]++
     for(i=3;i<=18;i++){s[l,i]+=$i; if(n[l]==1||$i<lo[l,i])lo[l,i]=$i; if(n[l]==1||$i>hi[l,i])hi[l,i]=$i}}
    END{for(j=1;j<=k;j++){l=ord[j]; printf "== %s  (%d runs)\n", l, n[l]
      for(i=3;i<=18;i++){m=s[l,i]/n[l]
        if(i<=11 && n[l]>1) printf "  %-16s %7.2f   (%.2f..%.2f)\n", h[i], m, lo[l,i], hi[l,i]
        else printf "  %-16s %7.2f\n", h[i], m}}}' $OUT
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "wpbench: needs root (run 'adb root' first; it resets on every reboot)"; exit 1; }
L=${1:?label}; D=${2:-60}; DL=${3:-0}; R=${4:-1}
[ "$DL" -gt 0 ] && sleep $DL
if [ "$R" -gt 1 ]; then
  i=0; while [ $i -lt $R ]; do sh $0 "$L" $D; i=$((i + 1)); done
  exit 0
fi

P=$(getprop dev.b2g.pid)
tabs=$(pgrep -f "true tab" | tr '\n' ' ')
hwc=$(pgrep -f vendor.qti.media.c2)
swc=$(pidof media.swcodec)
comp=$(pidof vendor.qti.hardware.display.composer-service)
kth=$(ps -A -o PID,NAME | grep -E "crtc_commit|kgsl_dispatcher|spi_kickoff|spi_fake_vsync|sde_" | awk '{print $1}' | tr '\n' ' ')

ticks() { t=0; for p in "$@"; do [ -r /proc/$p/stat ] && t=$((t + $(awk '{print $14+$15}' /proc/$p/stat))); done; echo $t; }
boot_cs() { awk '{printf "%d", $1*100}' /proc/uptime; }
mono_cs() { awk '/^now at/{printf "%d", $3/10000000; exit}' /proc/timer_list; }
sys() { awk '/^cpu /{s=0;for(i=2;i<=NF;i++)s+=$i; print s, $5}' /proc/stat; }
thr() {
  for t in /proc/$P/task/*; do
    s=$(awk '{print $14+$15}' $t/stat 2>/dev/null) && c=$(cat $t/comm 2>/dev/null) && echo "$s $(echo "$c" | tr ' ' _)"
  done; }
pss() { t=0; for p in "$@"; do [ -r /proc/$p/smaps_rollup ] && t=$((t + $(awk '/^Pss:/{print $2}' /proc/$p/smaps_rollup))); done; echo $t; }
gpu() { cat /sys/class/kgsl/kgsl/proc/$P/kernel 2>/dev/null || echo 0; }
dmabuf() { cat /sys/kernel/dmabuf/buffers/*/size 2>/dev/null | awk '{s+=$1}END{print s+0}'; }
avail() { awk '/^MemAvailable:/{print $2}' /proc/meminfo; }
scr() { echo "$(cat /sys/class/drm/card0-DSI-1/dpms) $(cat /sys/class/drm/card1-SPI-1/dpms)"; }

scr1=$(scr); sus1=$(cat /sys/power/suspend_stats/success)
thr > /data/local/tmp/wpb.t1
a1=$(ticks $P); b1=$(ticks $tabs); c1=$(ticks $hwc); d1=$(ticks $swc); e1=$(ticks $comp); f1=$(ticks $kth)
set -- $(sys); st1=$1; si1=$2; bt1=$(boot_cs); mt1=$(mono_cs)

n=0; mp=0; mt=0; mh=0; ms=0; mg=0; md=0; ma=0; left=$D
while [ $left -gt 0 ]; do
  s=$((left < 10 ? left : 10)); sleep $s; left=$((left - s))
  mp=$((mp + $(pss $P))); mt=$((mt + $(pss $tabs))); mh=$((mh + $(pss $hwc))); ms=$((ms + $(pss $swc)))
  mg=$((mg + $(gpu))); md=$((md + $(dmabuf))); ma=$((ma + $(avail))); n=$((n + 1))
done

a2=$(ticks $P); b2=$(ticks $tabs); c2=$(ticks $hwc); d2=$(ticks $swc); e2=$(ticks $comp); f2=$(ticks $kth)
set -- $(sys); st2=$1; si2=$2; bt2=$(boot_cs); mt2=$(mono_cs)
thr > /data/local/tmp/wpb.t2
scr2=$(scr); sus2=$(cat /sys/power/suspend_stats/success)

W=$((bt2 - bt1))
pct() { awk -v t=$1 -v w=$W 'BEGIN{printf "%.2f", 100*t/w}'; }
kb2mb() { awk -v k=$1 -v n=$2 'BEGIN{printf "%.1f", k/n/1024}'; }
awake=$(awk -v m=$((mt2 - mt1)) -v w=$W 'BEGIN{printf "%.0f", 100*m/w}')
busy=$(awk -v i=$((si2 - si1)) -v t=$((st2 - st1)) -v m=$((mt2 - mt1)) -v w=$W \
  'BEGIN{printf "%.2f", (t>0 ? 100*(1-i/t) : 0) * m/w}')
[ "$scr1" = "$scr2" ] && scrn="$scr2" || scrn="CHANGED"
usb=$(cat /sys/class/power_supply/usb/online 2>/dev/null)

row="$L,$((W / 100)),$awake,$((sus2 - sus1)),$(pct $((a2 - a1))),$(pct $((b2 - b1))),$(pct $((c2 - c1))),$(pct $((d2 - d1))),$(pct $((e2 - e1))),$(pct $((f2 - f1))),$busy"
row="$row,$(kb2mb $mp $n),$(kb2mb $mt $n),$(kb2mb $mh $n),$(kb2mb $ms $n),$(kb2mb $((mg / 1024)) $n),$(kb2mb $((md / 1024)) $n),$(kb2mb $ma $n)"
row="$row,$(echo $scrn | tr ' ' ,),$usb"
[ -s $OUT ] || echo "$HDR" > $OUT
echo "$row" >> $OUT

echo "$HDR" | tr , '\n' > /data/local/tmp/wpb.h
echo "$row" | tr , '\n' | paste /data/local/tmp/wpb.h - | awk '{printf "  %-16s %s\n", $1, $2}'
echo "  top b2g threads (% of one core):"
awk -v w=$W 'NR==FNR{a[$2]+=$1;next}{b[$2]+=$1}END{for(k in b){x=b[k]-a[k]; if(x>0) printf "    %5.2f%%  %s\n", 100*x/w, k}}' \
  /data/local/tmp/wpb.t1 /data/local/tmp/wpb.t2 | sort -rn | head -6
[ "$scrn" = CHANGED ] && echo "  WARNING: screen state changed during the window ($scr1 -> $scr2); discard this run"
rm -f /data/local/tmp/wpb.t1 /data/local/tmp/wpb.t2 /data/local/tmp/wpb.h

#!/system/bin/sh
OUT=/data/local/tmp/dump
rm -rf $OUT /data/local/tmp/dump.tar
mkdir -p $OUT/runtime $OUT/config $OUT/logs $OUT/b2g $OUT/listings $OUT/binaries

snap() {
  f=$1; shift; "$@" > "$OUT/runtime/$f" 2>&1; }

snap getprop.txt getprop
snap uname.txt uname -a
snap uptime.txt uptime
snap cpuinfo.txt cat /proc/cpuinfo
snap meminfo.txt cat /proc/meminfo
snap vmstat.txt cat /proc/vmstat
snap cmdline.txt cat /proc/cmdline
snap kernel-config.txt sh -c 'zcat /proc/config.gz'
snap mounts.txt cat /proc/mounts
snap df.txt df -h
snap partitions.txt ls -l /dev/block/by-name/
snap swaps.txt cat /proc/swaps
snap zram.txt sh -c 'for f in comp_algorithm disksize mm_stat io_stat; do echo "== $f"; cat /sys/block/zram0/$f; done'
snap pressure.txt sh -c 'for f in cpu memory io; do echo "== $f"; cat /proc/pressure/$f; done'
snap vm-sysctl.txt sh -c 'for f in /proc/sys/vm/*; do echo "$f=$(cat $f 2>/dev/null)"; done'
snap cpufreq.txt sh -c 'for p in /sys/devices/system/cpu/cpufreq/policy*; do echo "== $p"; for f in scaling_governor scaling_cur_freq scaling_min_freq scaling_max_freq cpuinfo_max_freq related_cpus scaling_available_governors; do echo "$f=$(cat $p/$f)"; done; done'
snap gpu.txt sh -c 'cd /sys/class/kgsl/kgsl-3d0 && for f in devfreq/governor devfreq/cur_freq max_gpuclk gpu_model gpubusy; do echo "$f=$(cat $f 2>/dev/null)"; done'
snap display.txt sh -c 'for c in /sys/class/drm/card*-*; do echo "$c status=$(cat $c/status) dpms=$(cat $c/dpms) enabled=$(cat $c/enabled)"; done; for b in /sys/class/backlight/*; do echo "$b brightness=$(cat $b/brightness)/$(cat $b/max_brightness)"; done'
snap wakeup-sources.txt sh -c 'for w in /sys/class/wakeup/*; do echo "$(cat $w/name) active_count=$(cat $w/active_count) total_ms=$(cat $w/total_time_ms) active_ms=$(cat $w/active_time_ms)"; done'
snap suspend-stats.txt sh -c 'for f in /sys/power/suspend_stats/*; do echo "$f=$(cat $f)"; done; cat /sys/power/mem_sleep'
snap io-sched.txt sh -c 'for b in /sys/block/*/queue/scheduler; do echo "$b: $(cat $b)"; done'
snap ps-processes.txt ps -A -o PID,PPID,USER,RSS,VSZ,PCY,STAT,NAME
snap ps-threads.txt ps -A -T -o PID,TID,USER,PCY,STAT,CMD,NAME
snap top.txt top -b -n 2 -d 3 -m 40 -s 3 -o PID,USER,%CPU,RES,NAME
snap top-threads.txt top -H -b -n 2 -d 3 -m 40 -s 3 -o TID,PID,%CPU,CMD,NAME
snap proc-cgroups-oom.txt sh -c 'for p in /proc/[0-9]*; do n=$(cat $p/comm 2>/dev/null) || continue; echo "${p#/proc/} $n oom=$(cat $p/oom_score_adj) $(cat $p/cgroup | tr "\n" " ")"; done'
snap memcg-b2g.txt sh -c 'for d in $(find /dev/memcg/b2g -type d); do echo "== $d"; for f in memory.usage_in_bytes memory.limit_in_bytes memory.soft_limit_in_bytes memory.swappiness; do echo "$f=$(cat $d/$f)"; done; done'
snap cgroup-dirs.txt sh -c 'ls -R /dev/cpuctl /dev/cpuset /dev/memcg | grep ":$"'
snap service-list.txt service list
snap binderfs.txt ls -la /dev/binderfs
snap init-svc-states.txt sh -c 'getprop | grep -E "init\.svc\."'
snap dumpsys-list.txt dumpsys -l
snap lsmod.txt cat /proc/modules
snap interrupts.txt cat /proc/interrupts
snap getenforce.txt getenforce
snap b2g-process-maps.txt sh -c 'cat /proc/$(getprop dev.b2g.pid)/maps'
snap b2g-threads.txt sh -c 'P=$(getprop dev.b2g.pid); for t in /proc/$P/task/*; do echo "${t##*/} $(cat $t/comm) $(awk "{print \$14+\$15}" $t/stat)"; done'
snap b2g-content-cmdlines.txt sh -c 'for p in $(pidof b2g); do echo "$p: $(tr "\0" " " < /proc/$p/cmdline)"; done'

logcat -d -b all -v threadtime > $OUT/logs/logcat-all.txt 2>&1
dmesg > $OUT/logs/dmesg.txt 2>&1
mkdir -p $OUT/logs/tombstones
for t in /data/tombstones/tombstone_[0-9][0-9]; do cp "$t" $OUT/logs/tombstones/ 2>/dev/null; done
ls -la /data/tombstones > $OUT/logs/tombstones/LISTING.txt 2>&1

copy_cfg() {
  find "$1" -type f -size -2048k \( -name '*.rc' -o -name '*.xml' -o -name '*.conf' -o -name '*.cfg' \
    -o -name '*.prop' -o -name '*.txt' -o -name '*.ini' -o -name '*.json' -o -name 'fstab*' -o -name '*.js' \
    -o -name '*.sh' -o -name 'ueventd*' -o -name '*.pb' -o -name '*_contexts' -o -name '*.cil' \) 2>/dev/null |
  while read f; do mkdir -p "$OUT/config$(dirname "$f")"; cp "$f" "$OUT/config$f" 2>/dev/null; done
}
for d in /system/etc /vendor/etc /system_ext/etc /product/etc /odm/etc; do copy_cfg $d; done
for f in /system/build.prop /vendor/build.prop /system_ext/etc/build.prop /product/etc/build.prop /odm/etc/build.prop \
         /vendor/odm/etc/build.prop /init.rc /init.environ.rc /default.prop /prop.default; do
  [ -f "$f" ] && { mkdir -p "$OUT/config$(dirname "$f")"; cp "$f" "$OUT/config$f"; }
done
ls /*.rc > /dev/null 2>&1 && for f in /*.rc; do cp "$f" "$OUT/config/"; done
for d in /apex/*/etc; do case "$d" in *@*) continue;; esac; copy_cfg "$d"; done

cp -r /system/b2g $OUT/b2g/system-b2g
cp -r /data/local/webapps $OUT/b2g/data-local-webapps 2>/dev/null
cp -r /data/b2g $OUT/b2g/data-b2g 2>/dev/null
cp /system/framework/*.jar $OUT/b2g/ 2>/dev/null
rm -f $OUT/b2g/framework.jar

for b in /system/bin/gonkservices /system/bin/b2gkillerd /system/bin/QtiTelephonyServiceforB2G \
         /system/bin/tctweb_server /system/bin/perfservice; do
  [ -f "$b" ] && cp "$b" $OUT/binaries/
done

for d in /system /vendor /system_ext /product /odm /apex; do
  n=$(echo "$d" | tr / _); ls -lR "$d" > "$OUT/listings/ls-lR$n.txt" 2>&1
done
ls -la /data/local/tmp > $OUT/listings/data-local-tmp.txt 2>&1

mkdir -p $OUT/userinit
cp /data/local/userinit/run.log /data/local/userinit/.installed-files $OUT/userinit/ 2>/dev/null
for l in /data/local/userinit/services/*/*.log; do cp "$l" $OUT/userinit/ 2>/dev/null; done
grep userinit /proc/self/mountinfo > $OUT/userinit/mounts.txt 2>&1

cd /data/local/tmp && tar -cf dump.tar dump && ls -la dump.tar && du -sm dump

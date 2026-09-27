#!/system/bin/sh
D=${1:-20}; P=$(getprop dev.b2g.pid)
snap() { for t in /proc/$P/task/*; do echo "$(awk '{print $14+$15}' $t/stat) $(cat $t/comm | tr ' ' '_')"; done; }
snap > /data/local/tmp/t1; sleep $D; snap > /data/local/tmp/t2
awk -v d=$D 'NR==FNR{a[$2]+=$1;next}{b[$2]+=$1}END{for(k in b){x=b[k]-a[k]; if(x>0) printf "%5.1f%%  %s\n", x/d, k}}' /data/local/tmp/t1 /data/local/tmp/t2 | sort -rn | head -6
rm -f /data/local/tmp/t1 /data/local/tmp/t2
echo "backlight=$(cat /sys/class/backlight/panel0-backlight/brightness) dsi=$(cat /sys/class/drm/card0-DSI-1/dpms) spi=$(cat /sys/class/drm/card1-SPI-1/dpms)"

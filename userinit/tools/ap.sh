#!/system/bin/sh
export ANDROID_DATA=/data/local/tmp/artdata
export ANDROID_ROOT=/system ANDROID_ART_ROOT=/apex/com.android.art ANDROID_I18N_ROOT=/apex/com.android.i18n ANDROID_TZDATA_ROOT=/apex/com.android.tzdata
mkdir -p $ANDROID_DATA/dalvik-cache/arm
J=/apex/com.android.art/javalib
export BOOTCLASSPATH=$J/core-oj.jar:$J/core-libart.jar:$J/okhttp.jar:$J/bouncycastle.jar:$J/apache-xml.jar:/apex/com.android.i18n/javalib/core-icu4j.jar:/system/framework/framework.jar:/apex/com.android.conscrypt/javalib/conscrypt.jar:/apex/com.android.media/javalib/updatable-media.jar:/apex/com.android.mediaprovider/javalib/framework-mediaprovider.jar:/apex/com.android.os.statsd/javalib/framework-statsd.jar:/apex/com.android.permission/javalib/framework-permission.jar:/apex/com.android.permission/javalib/framework-permission-s.jar:/apex/com.android.tethering/javalib/framework-connectivity.jar:/apex/com.android.tethering/javalib/framework-connectivity-t.jar:/apex/com.android.tethering/javalib/framework-tethering.jar
export DEX2OATBOOTCLASSPATH=${BOOTCLASSPATH%%:/apex/com.android.conscrypt*}
export CLASSPATH=$1; shift
exec /system/bin/app_process /system/bin "$@"

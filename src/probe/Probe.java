import java.lang.reflect.Method;
import java.util.Arrays;

public class Probe {
    static void test(String name, ThrowingRunnable r) {
        try {
            Object result = r.run();
            System.out.println("[OK]   " + name + " -> " + result);
        } catch (Throwable t) {
            Throwable c = t;
            while (c.getCause() != null) c = c.getCause();
            System.out.println("[FAIL] " + name + " -> " + c.getClass().getSimpleName() + ": " + c.getMessage());
        }
    }

    interface ThrowingRunnable { Object run() throws Throwable; }

    static Object call(String cls, String method, Class<?>[] types, Object... args) throws Throwable {
        Method m = Class.forName(cls).getMethod(method, types);
        return m.invoke(null, args);
    }

    static long bench() {
        long t0 = System.nanoTime();
        int n = 2_000_000;
        boolean[] composite = new boolean[n];
        int primes = 0;
        for (int i = 2; i < n; i++) {
            if (!composite[i]) { primes++; for (long j = (long) i * i; j < n; j += i) composite[(int) j] = true; }
        }
        double acc = 0;
        for (int i = 1; i < 3_000_000; i++) acc += Math.sqrt(i) / i;
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 200_000; i++) { sb.append(i % 10); if (sb.length() > 1000) sb.setLength(0); }
        long ms = (System.nanoTime() - t0) / 1_000_000;
        if (primes == 0 || acc == 0) System.out.println("unreachable");
        return ms;
    }

    public static void main(String[] args) throws Throwable {
        System.out.println("vm=" + System.getProperty("java.vm.name") + " " + System.getProperty("java.vm.version")
                + " arch=" + System.getProperty("os.arch"));

        if (args.length > 0 && args[0].equals("bench")) {
            for (int i = 1; i <= 5; i++) System.out.println("bench run " + i + ": " + bench() + " ms");
            return;
        }

        test("core: java.util / crypto", () -> {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest("hello".getBytes());
            return String.format("sha256[0..4]=%02x%02x%02x%02x", d[0], d[1], d[2], d[3]);
        });
        test("framework: android.os.Build.MODEL", () -> Class.forName("android.os.Build").getField("MODEL").get(null));
        test("framework: SystemProperties.get(ro.build.version.sdk)", () ->
                call("android.os.SystemProperties", "get", new Class<?>[]{String.class}, "ro.build.version.sdk"));
        test("framework: android.util.Log.i", () ->
                call("android.util.Log", "i", new Class<?>[]{String.class, String.class}, "ProbeTest", "hello from dex"));
        test("binder: ServiceManager.listServices().length", () -> {
            String[] s = (String[]) call("android.os.ServiceManager", "listServices", new Class<?>[]{});
            return s.length + " services, e.g. " + Arrays.toString(Arrays.copyOf(s, 3));
        });
        test("binder: getService(\"activity\") descriptor", () -> {
            Object b = call("android.os.ServiceManager", "getService", new Class<?>[]{String.class}, "activity");
            return b == null ? "null" : b.getClass().getName() + " / " + b.getClass().getMethod("getInterfaceDescriptor").invoke(b);
        });
        test("app layer: ActivityThread.systemMain()", () ->
                call("android.app.ActivityThread", "systemMain", new Class<?>[]{}));
        test("graphics: Bitmap+Canvas shapes -> PNG", () -> drawPng(false));
        test("graphics: text (Typeface) -> PNG", () -> drawPng(true));
    }

    static Object drawPng(boolean withText) throws Throwable {
        {
            Class<?> bmCls = Class.forName("android.graphics.Bitmap");
            Class<?> cfgCls = Class.forName("android.graphics.Bitmap$Config");
            Object argb = cfgCls.getField("ARGB_8888").get(null);
            Object bmp = bmCls.getMethod("createBitmap", int.class, int.class, cfgCls).invoke(null, 240, 120, argb);
            Class<?> canvasCls = Class.forName("android.graphics.Canvas");
            Object canvas = canvasCls.getConstructor(bmCls).newInstance(bmp);
            canvasCls.getMethod("drawColor", int.class).invoke(canvas, 0xFF3060C0);
            Class<?> paintCls = Class.forName("android.graphics.Paint");
            Object paint = paintCls.getConstructor().newInstance();
            paintCls.getMethod("setColor", int.class).invoke(paint, 0xFFFFFFFF);
            canvasCls.getMethod("drawCircle", float.class, float.class, float.class, paintCls)
                    .invoke(canvas, 60f, 60f, 40f, paint);
            if (withText) {
                Class<?> tfCls = Class.forName("android.graphics.Typeface");
                Object tf = tfCls.getMethod("createFromFile", String.class).invoke(null, "/system/fonts/DroidSans.ttf");
                java.util.Map<String, Object> map = new java.util.HashMap<>();
                map.put("sans-serif", tf);
                tfCls.getMethod("setSystemFontMap", java.util.Map.class).invoke(null, map);
                paintCls.getMethod("setTextSize", float.class).invoke(paint, 28f);
                paintCls.getMethod("setAntiAlias", boolean.class).invoke(paint, true);
                canvasCls.getMethod("drawText", String.class, float.class, float.class, paintCls)
                        .invoke(canvas, "Android on B2G", 110f, 70f, paint);
            }
            Class<?> fmt = Class.forName("android.graphics.Bitmap$CompressFormat");
            try (java.io.FileOutputStream out = new java.io.FileOutputStream("/data/local/tmp/probe.png")) {
                bmCls.getMethod("compress", fmt, int.class, java.io.OutputStream.class)
                        .invoke(bmp, fmt.getField("PNG").get(null), 100, out);
            }
            return "wrote /data/local/tmp/probe.png (" + new java.io.File("/data/local/tmp/probe.png").length() + " bytes)";
        }
    }
}

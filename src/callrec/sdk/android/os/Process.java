package android.os;

public class Process {
    public static int myUid() {
        return 0;
    }

    public static int myPid() {
        return (int) ProcessHandle.current().pid();
    }
}

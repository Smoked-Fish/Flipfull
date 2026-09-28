MIT License

Copyright (c) 2026 Espy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

This MIT license covers only the files original to this project. Bundled
third-party components keep their own licenses:

  - src/overlays/base/*/application.zip are stock KaiOS/TCL apps from the
    phone; they are proprietary and not covered by any license granted here.
  - userinit/bin/busybox is BusyBox 1.37.0, GPLv2. Source: busybox.net,
    built with src/native/busybox-1.37.0-armhf.config.
  - userinit/bin/sqlite3 is SQLite, public domain.
  - userinit/services/stt/stt-server includes whisper.cpp (MIT, (c) the
    ggml authors).

Follow each component's own terms when you redistribute it.

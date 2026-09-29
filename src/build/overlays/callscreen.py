from ..edits import Overlay, Patch, insert_before
from ..snippets import script

RECORDING_JS = "js/call_recording.js"

OVERLAY = Overlay(edits=[
    insert_before("index.html",
                  script("/js/call_recording.js", attrs='defer="" type="application/javascript"'),
                  script("/js/flipfull_callrec.js", attrs='defer="" type="application/javascript"')),
    Patch(RECORDING_JS,
          'navigator.mediaDevices.getUserMedia({audio:{audioSource:"voicecall"}})',
          'FlipfullCallRec.open()'),
    Patch(RECORDING_JS, 'v=new MediaRecorder(e)', 'v=new FlipfullCallRec.Recorder(e)'),
    Patch(RECORDING_JS, 'y.push(e.data),b=new Date', 'y.push(e.data),b=v&&v.stoppedAt||new Date'),
    Patch(RECORDING_JS, 'if(n<d)DUMP(', 'if(n<d||!e.size)DUMP('),
    Patch(RECORDING_JS, 't=S(l)', 't=FlipfullCallRec.ext||S(l)'),
])

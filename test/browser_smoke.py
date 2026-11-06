"""Drives the real front-end in headless Chromium (fake webcam) against the real server
on a fake DB. MediaPipe / COCO-SSD are replaced by controllable stubs because the CDN is
not reachable from CI; everything else (proctoring.js, app.js, server) is the real code.

    pip install playwright && playwright install chromium
    python3 test/browser_smoke.py
"""
import json, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

PORT = 3199
BASE = f"http://127.0.0.1:{PORT}"
MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs"

STUB_MP = """
export const FilesetResolver = { forVisionTasks: async () => ({}) };
export const FaceDetector = { createFromOptions: async () => ({ detectForVideo: () => ({ detections: window.__faces || [] }) }) };
"""
STUB_COCO = "window.cocoSsd={load:async()=>({detect:async()=>window.__objects||[]})};"
GOOD = {"boundingBox": {"width": 200, "height": 200}, "categories": [{"score": 0.95}],
        "keypoints": [{"x": .4, "y": .4}, {"x": .6, "y": .4}, {"x": .5, "y": .5}, {"x": .5, "y": .6}]}
FAR = {"boundingBox": {"width": 40, "height": 40}, "categories": [{"score": 0.9}], "keypoints": GOOD["keypoints"]}
TURNED = {**GOOD, "keypoints": [{"x": .4, "y": .4}, {"x": .6, "y": .4}, {"x": .75, "y": .5}, {"x": .5, "y": .6}]}

def state():
    return json.load(urllib.request.urlopen(BASE + "/__debug/state"))

def counted(events, t):
    return [e for e in events if e["event_type"] == t and e["counted"]]

def wait_for(cond, timeout, label):
    end = time.time() + timeout
    while time.time() < end:
        if cond(): return
        time.sleep(0.25)
    raise AssertionError("timeout waiting for: " + label)

def route_stubs(ctx):
    ctx.route(MP, lambda r: r.fulfill(status=200, content_type="text/javascript", body=STUB_MP))
    ctx.route("**/tf.min.js", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
    ctx.route("**/coco-ssd.min.js", lambda r: r.fulfill(status=200, content_type="text/javascript", body=STUB_COCO))
    ctx.route("https://storage.googleapis.com/**", lambda r: r.fulfill(status=200, body=b""))

def begin(browser, n):
    ctx = browser.new_context(permissions=["camera"], viewport={"width": 1280, "height": 800})
    route_stubs(ctx)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "/")
    page.evaluate("window.__faces = %s" % json.dumps([GOOD]))
    page.wait_for_function("typeof selectTest === 'function'")
    page.evaluate("loadTests()")
    page.wait_for_selector(".assessment-card")
    page.evaluate("selectTest('T1')")
    page.evaluate("""(n)=>{const v={fullName:'Browser '+n,collegeName:'Col',rollNumber:'BR'+n,mobileNumber:'98000000'+String(n).padStart(2,'0'),semester:'4',branch:'CSE',course:'BTech'};
      for(const k in v) document.getElementById(k).value=v[k];}""", n)
    page.evaluate("startTest()")
    page.wait_for_function("document.getElementById('instructions').classList.contains('active') || location.pathname==='/instructions'")
    page.evaluate("document.getElementById('stpCameraConsent').checked=true")
    page.evaluate("beginExam()")
    page.wait_for_function("document.body.classList.contains('exam')", timeout=20000)
    return ctx, page, errors

def main():
    server = subprocess.Popen(["node", "test/serve-fake.js"], env={**__import__('os').environ, "PORT": str(PORT)}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        wait_for(lambda: server.poll() is None and _up(), 15, "server up")
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
            run_main_flow(browser)
            run_camera_lost_flow(browser)
            run_pre_check(browser)
            browser.close()
        print("BROWSER SMOKE TEST PASSED")
    finally:
        server.terminate()

def _up():
    try: urllib.request.urlopen(BASE + "/api/health", timeout=1); return True
    except Exception: return True if _alive() else False

def _alive():
    try: urllib.request.urlopen(BASE + "/api/tests", timeout=1); return True
    except Exception: return False

def run_main_flow(browser):
    ctx, page, errors = begin(browser, 1)
    questions = page.evaluate("test.questions.length")
    assert questions == 3, questions
    # questions came from /start; list endpoint never carried them
    assert page.evaluate("document.getElementById('qn').textContent").startswith("Question 1 of 3")
    print("  exam started; first screen rendered")

    # A) a tiny far-away face (poster / person across the room) must NOT be a strike
    page.evaluate("window.__faces=%s" % json.dumps([GOOD, FAR]))
    time.sleep(4.5)
    assert not state()["events"], state()["events"]
    print("  A ok: far-away second face ignored")

    # F) head turned for a long time -> review-only flag, no strike
    page.evaluate("window.__faces=%s" % json.dumps([TURNED]))
    wait_for(lambda: any(e["event_type"] == "looking_away" for e in state()["events"]), 12, "looking_away flag")
    s = state()
    assert not any(e["counted"] for e in s["events"]) and s["sessions"][0]["violation_count"] == 0
    print("  F ok: looking_away logged as review-only")

    # B) a second real face close to the screen -> strike 1
    page.evaluate("window.__faces=%s" % json.dumps([GOOD, GOOD]))
    wait_for(lambda: counted(state()["events"], "multiple_faces"), 10, "multiple_faces strike")
    assert state()["sessions"][0]["violation_count"] == 1
    print("  B ok: multiple_faces strike 1")

    # C) nobody in front of the camera -> strike 2 (after the 5 s anti-burst window)
    page.evaluate("window.__faces=[]")
    wait_for(lambda: counted(state()["events"], "face_missing"), 20, "face_missing strike")
    assert state()["sessions"][0]["violation_count"] == 2
    print("  C ok: face_missing strike 2")

    # heartbeat reached the server with camera/model state
    cs = state()["sessions"][0]["client_state"]
    assert cs.get("camera") is True and cs.get("models") is True, cs
    print("  heartbeat ok:", cs)

    # D) phone -> strike 3 -> termination -> automatic submit
    page.evaluate("window.__faces=%s; window.__objects=%s" % (json.dumps([GOOD]), json.dumps([{"class": "cell phone", "score": 0.6}])))
    page.wait_for_function("location.pathname==='/submitted'", timeout=40000)
    s = state()
    assert counted(s["events"], "phone_detected"), s["events"]
    assert len(s["attempts"]) == 1 and s["attempts"][0]["violations"] == 3
    assert s["sessions"][0]["status"] == "submitted"
    print("  D ok: phone strike 3 -> terminated -> auto-submitted with 3 violations")
    assert not errors, errors
    ctx.close()

def run_camera_lost_flow(browser):
    ctx, page, errors = begin(browser, 2)
    # camera disappears and cannot be re-acquired (unplugged / blocked)
    page.evaluate("""navigator.mediaDevices.getUserMedia=()=>Promise.reject(new Error('blocked'));
      document.getElementById('stpVideo').srcObject.getTracks().forEach(t=>t.stop());""")
    sid = [x for x in state()["sessions"] if x["roll_number"] == "BR2"][0]["id"]
    wait_for(lambda: any(e["session_id"] == sid and e["event_type"] == "camera_lost" and e["counted"] for e in state()["events"]), 15, "camera_lost strike")
    print("  camera_lost ok: unplugged camera is now a strike")
    assert not errors, errors
    ctx.close()

def run_pre_check(browser):
    # Nobody in front of the camera at start: exam must NOT begin.
    ctx = browser.new_context(permissions=["camera"])
    route_stubs(ctx)
    page = ctx.new_page()
    page.goto(BASE + "/")
    page.evaluate("window.__faces=[]")
    page.wait_for_function("typeof selectTest === 'function'")
    page.evaluate("loadTests()"); page.wait_for_selector(".assessment-card")
    page.evaluate("selectTest('T1')")
    page.evaluate("""()=>{const v={fullName:'Pre',collegeName:'C',rollNumber:'BR3',mobileNumber:'9800000003',semester:'4',branch:'CSE',course:'BTech'};for(const k in v)document.getElementById(k).value=v[k];}""")
    page.evaluate("startTest()")
    page.wait_for_function("location.pathname==='/instructions'")
    page.evaluate("document.getElementById('stpCameraConsent').checked=true")
    page.evaluate("beginExam()")
    page.wait_for_function("document.getElementById('stpStatus').textContent.includes('face')", timeout=5000)
    time.sleep(10.5)
    assert not page.evaluate("document.body.classList.contains('exam')")
    assert not [x for x in state()["sessions"] if x["roll_number"] == "BR3"], "no session may be created without a visible face"
    print("  pre-check ok: exam refuses to start with no face visible")
    ctx.close()

if __name__ == "__main__":
    main()

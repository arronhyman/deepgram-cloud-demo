// YOUR SPECIFIC LAMBDA URL
const API_URL = "https://sapucalvhlquhnlmlerjslz7se0gmbto.lambda-url.us-east-1.on.aws/";

let socket;
let mediaRecorder;
let deepgramKey;

// TTS state
let isSpeaking = false;
let currentAudio = null;

// Transcript debounce
let lastTranscriptTime = 0;

document.getElementById('micBtn').addEventListener('click', async () => {
    const btn = document.getElementById('micBtn');

    // ----------------------
    // STOP SESSION
    // ----------------------
    if (btn.classList.contains("active")) {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        if (socket) socket.close();

        if (currentAudio) {
            currentAudio.pause();
            currentAudio = null;
            isSpeaking = false;
        }

        btn.innerText = "Start Demo";
        btn.classList.remove("active");
        document.getElementById('transcript').innerText = "Session ended.";
        document.getElementById('ai-response').innerText = "";
        return;
    }

    // ----------------------
    // AUTH
    // ----------------------
    btn.innerText = "Connecting...";
    try {
        const authRes = await fetch(API_URL + "?route=auth");
        const authData = await authRes.json();

        if (!authData.key) {
            throw new Error(authData.error || "No API key returned");
        }

        deepgramKey = authData.key;
    } catch (e) {
        alert("Auth Error: " + e.message);
        btn.innerText = "Start Demo";
        return;
    }

    // ----------------------
    // MICROPHONE
    // ----------------------
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        alert("Microphone Error: " + e.message);
        btn.innerText = "Start Demo";
        return;
    }

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    // ----------------------
    // DEEPGRAM WS
    // ----------------------
    const dgParams = "model=nova-2&smart_format=true&sentiment=true&punctuate=true";
    socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${dgParams}`, [
        "token",
        deepgramKey
    ]);

    socket.onopen = () => {
        btn.innerText = "Stop";
        btn.classList.add("active");
        document.getElementById('transcript').innerText = "Listening...";

        mediaRecorder.addEventListener('dataavailable', event => {
            if (event.data.size > 0 && socket.readyState === 1) {
                socket.send(event.data);
            }
        });

        mediaRecorder.start(250);
    };

    socket.onmessage = async (message) => {
        const received = JSON.parse(message.data);
        const alternative = received.channel?.alternatives?.[0];

        if (!received.is_final || !alternative?.transcript) return;

        // ----------------------
        // DEBOUNCE FINALS
        // ----------------------
        const now = Date.now();
        if (now - lastTranscriptTime < 1500) return;
        lastTranscriptTime = now;

        const transcript = alternative.transcript;
        const sentiment = alternative.sentiment || "neutral";

        document.getElementById('transcript').innerHTML =
            `You (${sentiment}): ${transcript}`;

        // ----------------------
        // SEND TO AI
        // ----------------------
        document.getElementById('ai-response').innerText = "AI thinking...";

        try {
            const brainRes = await fetch(API_URL, {
                method: "POST",
                body: JSON.stringify({
                    text: transcript,
                    sentiment: sentiment
                })
            });

            const brainData = await brainRes.json();
            const aiResponse = brainData.response;

            document.getElementById('ai-response').innerText =
                `AI: ${aiResponse}`;

            // ----------------------
            // SPEAK (SERIALIZED)
            // ----------------------
            await speakWithDeepgram(aiResponse);

        } catch (e) {
            document.getElementById('ai-response').innerText =
                "AI Error.";
            console.error("AI Error:", e);
        }
    };

    socket.onclose = () => {
        if (btn.classList.contains("active")) {
            btn.click();
        }
    };
});

// ----------------------
// TTS (NO OVERLAP)
// ----------------------
async function speakWithDeepgram(text) {
    if (!deepgramKey || isSpeaking) return;

    isSpeaking = true;

    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }

    const url = "https://api.deepgram.com/v1/speak?model=aura-asteria-en";

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Token ${deepgramKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ text })
        });

        const blob = await response.blob();
        const audioUrl = URL.createObjectURL(blob);
        currentAudio = new Audio(audioUrl);

        currentAudio.onended = () => {
            isSpeaking = false;
            currentAudio = null;
        };

        currentAudio.onerror = () => {
            isSpeaking = false;
            currentAudio = null;
        };

        await currentAudio.play();

    } catch (e) {
        console.error("TTS Error:", e);
        isSpeaking = false;
        currentAudio = null;
    }
}
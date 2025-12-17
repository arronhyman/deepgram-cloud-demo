// YOUR SPECIFIC LAMBDA URL
const API_URL = "https://sapucalvhlquhnlmlerjslz7se0gmbto.lambda-url.us-east-1.on.aws/";

let socket;              // Deepgram STT WebSocket
let mediaRecorder;
let deepgramKey;

let ttsSocket = null;        // Deepgram TTS Streaming WebSocket
let ttsAudioContext = null;
let isSpeaking = false;      // Prevent overlap

document.getElementById('micBtn').addEventListener('click', async () => {
    const btn = document.getElementById('micBtn');

    // Stop session
    if (btn.classList.contains("active")) {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        if (socket) socket.close();
        if (ttsSocket) { ttsSocket.close(); ttsSocket = null; }
        if (ttsAudioContext) { ttsAudioContext.close(); ttsAudioContext = null; }
        isSpeaking = false;

        btn.innerText = "Start Demo";
        btn.classList.remove("active");
        document.getElementById('transcript').innerText = "Session ended.";
        document.getElementById('ai-response').innerText = "";
        return;
    }

    // Start session
    btn.innerText = "Connecting...";
    try {
        const authRes = await fetch(API_URL + "?route=auth");
        if (!authRes.ok) throw new Error("Auth failed");
        const authData = await authRes.json();
        if (!authData.key) throw new Error("No key returned");
        deepgramKey = authData.key;
    } catch (e) {
        alert("Auth Error: " + e.message);
        btn.innerText = "Start Demo";
        return;
    }

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        alert("Microphone Error: " + e.message);
        btn.innerText = "Start Demo";
        return;
    }

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    // STT with reliable turn detection
    const dgParams = "model=nova-2&smart_format=true&sentiment=true&punctuate=true&endpointing=700&interim_results=true&utterance_end_ms=1500";
    socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${dgParams}`, ['token', deepgramKey]);

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

        // Handle utterance end as fallback
        if (received.type === 'UtteranceEnd') {
            const currentText = document.getElementById('transcript').innerText;
            const transcript = currentText.replace(/^You.*?: /, '').replace('...', '').trim();
            if (transcript) {
                await processUserTurn(transcript, 'neutral'); // fallback sentiment
            }
            return;
        }

        if (received.type === 'Metadata') return;

        const alternative = received.channel?.alternatives[0];

        // Show live interim transcription
        if (!received.is_final && alternative?.transcript) {
            document.getElementById('transcript').innerHTML = `You: ${alternative.transcript}...`;
        }

        // Primary trigger: solid final transcript with speech_final
        if (alternative && received.is_final && received.speech_final && alternative.transcript.trim()) {
            const transcript = alternative.transcript.trim();
            const sentiment = alternative.sentiment || 'neutral';
            await processUserTurn(transcript, sentiment);
        }
    };

    socket.onclose = () => {
        if (btn.classList.contains("active")) btn.click();
    };

    socket.onerror = (err) => {
        console.error("STT Error:", err);
        alert("Speech recognition error.");
        btn.click();
    };
});

// Shared function to handle user turn → LLM → TTS
async function processUserTurn(transcript, sentiment) {
    document.getElementById('transcript').innerHTML = `You (${sentiment}): ${transcript}`;
    document.getElementById('ai-response').innerText = "AI thinking...";

    try {
        const brainRes = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: transcript, sentiment: sentiment })
        });

        if (!brainRes.ok) throw new Error("Brain request failed");

        const brainData = await brainRes.json();
        const aiResponse = brainData.response?.trim();

        if (aiResponse) {
            document.getElementById('ai-response').innerText = `AI: ${aiResponse}`;
            await speakWithDeepgram(aiResponse);
        } else {
            document.getElementById('ai-response').innerText = "No response.";
        }
    } catch (err) {
        console.error("Brain error:", err);
        document.getElementById('ai-response').innerText = "Error getting response.";
    }
}

// Low-latency streaming TTS using raw PCM (works reliably)
async function speakWithDeepgram(text) {
    if (!deepgramKey || isSpeaking) {
        console.log("Skipped TTS: already speaking or no key");
        return;
    }

    isSpeaking = true;
    document.getElementById('ai-response').innerText = `AI (speaking): ${text}`;

    // Clean up any previous connection
    if (ttsSocket) ttsSocket.close();
    if (ttsAudioContext) ttsAudioContext.close();

    ttsAudioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Request linear16 PCM at 24kHz (best quality for Aura)
    ttsSocket = new WebSocket(
        `wss://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=24000&container=none`,
        ['token', deepgramKey]
    );

    ttsSocket.onopen = () => {
        ttsSocket.send(JSON.stringify({ type: 'Speak', text }));
        ttsSocket.send(JSON.stringify({ type: 'Flush' }));
    };

    ttsSocket.onmessage = async (event) => {
        if (event.data instanceof Blob) {
            const arrayBuffer = await event.data.arrayBuffer();

            // Create buffer: mono, 16-bit PCM → float32
            const audioBuffer = ttsAudioContext.createBuffer(1, arrayBuffer.byteLength / 2, 24000);
            const channelData = audioBuffer.getChannelData(0);
            const view = new DataView(arrayBuffer);

            for (let i = 0; i < channelData.length; i++) {
                channelData[i] = view.getInt16(i * 2, true) / 32768; // little-endian
            }

            const source = ttsAudioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ttsAudioContext.destination);
            source.start(0);
        }
    };

    ttsSocket.onclose = () => {
        isSpeaking = false;
        if (ttsAudioContext && ttsAudioContext.state !== 'closed') {
            ttsAudioContext.close();
        }
    };

    ttsSocket.onerror = (err) => {
        console.error("TTS WebSocket error:", err);
        isSpeaking = false;
    };
}
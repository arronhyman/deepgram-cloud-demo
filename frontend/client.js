const API_URL = "https://sapucalvhlquhnlmlerjslz7se0gmbto.lambda-url.us-east-1.on.aws/"; 

let socket;
let mediaRecorder;
let deepgramKey; 

// STATE MANAGEMENT
let isAiSpeaking = false;        // "Gate" to stop listening when AI talks
let audioPlayPromise = Promise.resolve(); // The new "Timeline" for audio playback

document.getElementById('micBtn').addEventListener('click', async () => {
    const btn = document.getElementById('micBtn');
    
    // Toggle Logic
    if (btn.classList.contains("active")) {
        stopEverything();
        return;
    }

    // 1. Get Auth Token
    btn.innerText = "Connecting...";
    try {
        const authRes = await fetch(API_URL + "?route=auth");
        const authData = await authRes.json();
        
        if (!authData.key) throw new Error(authData.error || "No Key Returned");
        deepgramKey = authData.key;
    } catch (e) {
        alert("Auth Error: " + e.message);
        btn.innerText = "Start Demo";
        return;
    }

    // 2. Open Microphone
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        alert("Microphone Error: " + e.message);
        return;
    }
    
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    // 3. Connect to Deepgram (STT)
    // punctuate=true helps us parse sentences better if we were streaming text back
    const dgParams = "model=nova-2&smart_format=true&sentiment=true&punctuate=true&endpointing=300";
    socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${dgParams}`, [
        'token', deepgramKey
    ]);

    socket.onopen = () => {
        btn.innerText = "Stop";
        btn.classList.add("active");
        document.getElementById('transcript').innerText = "Listening...";
        
        mediaRecorder.addEventListener('dataavailable', event => {
            // CRITICAL: Only send audio if the AI is NOT speaking.
            if (event.data.size > 0 && socket.readyState === 1 && !isAiSpeaking) {
                socket.send(event.data);
            }
        });
        mediaRecorder.start(250);
    };

    socket.onmessage = async (message) => {
        const received = JSON.parse(message.data);
        const alternative = received.channel?.alternatives[0];
        
        if (alternative && received.is_final) {
            const transcript = alternative.transcript;
            const sentiment = alternative.sentiment;
            
            // Only proceed if there is actual text
            if (transcript && transcript.trim().length > 0) {
                document.getElementById('transcript').innerHTML = 
                    `You (${sentiment}): ${transcript}`;
                
                // 4. Send to Bedrock (Brain)
                document.getElementById('ai-response').innerText = "AI thinking...";
                
                // Pause mic immediately so we don't interrupt the AI thinking
                isAiSpeaking = true; 
                
                handleAiProcessing(transcript, sentiment);
            }
        }
    };
    
    socket.onclose = () => {
        if (btn.classList.contains("active")) stopEverything();
    };
});

function stopEverything() {
    const btn = document.getElementById('micBtn');
    if(mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    if(socket) socket.close();
    
    btn.innerText = "Start Demo";
    btn.classList.remove("active");
    document.getElementById('transcript').innerText = "Session ended.";
    
    // Reset flags
    isAiSpeaking = false;
    // We cannot easily cancel promises, but the audio player checks 
    // the 'isAiSpeaking' flag (in the stop logic context, we might want a separate flag or reload)
    // ideally, you might reload the page or mute audio here.
}

// --- OPTIMIZED AI PROCESSING ---

async function handleAiProcessing(text, sentiment) {
    try {
        const brainRes = await fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify({ text, sentiment })
        });
        const brainData = await brainRes.json();
        const fullText = brainData.response;
        
        document.getElementById('ai-response').innerText = `AI: ${fullText}`;
        
        // 1. SPLIT TEXT INTO SENTENCES
        // This regex splits by punctuation (. ! ?) but keeps the punctuation attached.
        const sentences = fullText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [fullText];

        // 2. PROCESS AUDIO PIPELINE
        // We iterate through sentences and queue them up.
        // Because 'queueAudio' handles the fetching asynchronously, 
        // the network requests for sentence #2 start while sentence #1 is preparing to play.
        for (const sentence of sentences) {
            const trimmed = sentence.trim();
            if (trimmed.length > 0) {
                await queueAudio(trimmed);
            }
        }
        
    } catch (e) {
        console.error("AI Error:", e);
        isAiSpeaking = false; // Release lock on error
    }
}

// --- PIPELINED AUDIO QUEUE SYSTEM ---

async function queueAudio(text) {
    // A. Start fetching the audio IMMEDIATELY.
    // We do not await this yet. We want the download to start NOW.
    const audioBlobPromise = fetchDeepgramAudio(text);

    // B. Schedule the playback.
    // We chain this new playback to the end of the 'audioPlayPromise' timeline.
    audioPlayPromise = audioPlayPromise
        .then(async () => {
            // Wait for the download to finish (if it hasn't already)
            const blob = await audioBlobPromise; 
            if (!blob) return;
            
            // Return a new promise that resolves only when this specific audio clip finishes playing
            return new Promise((resolve) => {
                // Double check user didn't hit stop
                const btn = document.getElementById('micBtn');
                if (!btn.classList.contains("active")) {
                    resolve();
                    return;
                }

                const audioUrl = URL.createObjectURL(blob);
                const audio = new Audio(audioUrl);
                
                audio.onended = () => {
                    resolve(); // This clip is done, ready for the next one
                };
                
                audio.play().catch(e => {
                    console.error("Play error", e);
                    resolve(); // Skip if error
                });
            });
        })
        .finally(() => {
            // This runs after the specific clip finishes. 
            // We need a way to detect if the ENTIRE queue is empty to un-mute the mic.
            // A simple hack: check if the queue is "caught up" after a tiny delay.
            setTimeout(() => {
                // If we are actively processing, we assume more links are in the chain.
                // But since we can't easily inspect the Promise chain length, 
                // we rely on the fact that handleAiProcessing loops await queueAudio.
                // So we actually handle the "All Done" logic better in handleAiProcessing?
                // No, because queueAudio returns before playback finishes.
                
                // Simple workaround: We leave isAiSpeaking = true.
                // We only set it to false if we know for sure we are done.
                // See step C below.
            }, 50);
        });

    // C. Handle the "End of Conversation" logic
    // We want to know when the VERY LAST audio finishes to open the mic.
    // We can piggyback on the promise chain's current tail.
    // Note: This logic runs every time we add a sentence, but it only "sticks" for the last one.
    audioPlayPromise.then(() => {
        // If this block runs, it means the audio queue is currently empty/finished.
        const btn = document.getElementById('micBtn');
        if (btn.classList.contains("active")) {
            isAiSpeaking = false; // Open the mic
            console.log("Mic Re-opened");
        }
    });
}

async function fetchDeepgramAudio(text) {
    if (!deepgramKey) return null;
    
    // OPTIMIZATION: encoding=linear16 (WAV) is much faster to decode than MP3
    // sample_rate=24000 is a good balance of quality and speed
    const url = "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=24000";
    
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Token ${deepgramKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ text: text })
        });
        return await response.blob();
    } catch (e) {
        console.error("TTS Error:", e);
        return null;
    }
}
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { AudioStreamer } from './lib/audio-streamer';
import { base64ToArrayBuffer, audioContext } from './lib/utils';
import './index.css';

// Type augmentations for Web Speech API
declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

interface TranslationItem {
  source: string;
  translated: string;
}

interface AudioDevice {
  deviceId: string;
  label: string;
}

export default function App() {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gemini-2.5-flash');
  const [sourceLang, setSourceLang] = useState('en-US');
  const [targetLang, setTargetLang] = useState('es-ES');
  
  const [ytUrl, setYtUrl] = useState('');
  const [ytEmbedUrl, setYtEmbedUrl] = useState('https://www.youtube.com/embed/5f4JvWeSInY?rel=0');
  
  // Zoom State
  const [zoomToken, setZoomToken] = useState('');
  const [zoomMeetingId, setZoomMeetingId] = useState('');
  const [isFetchingZoom, setIsFetchingZoom] = useState(false);

  const [status, setStatus] = useState('Ready');
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [finalTranscript, setFinalTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [translations, setTranslations] = useState<TranslationItem[]>([]);
  
  // Audio Source State
  const [currentAudioSource, setCurrentAudioSource] = useState<'mic' | 'device'>('mic');
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState('');
  
  // Audio Output State (Speaker Separation)
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState('');

  // Logic Refs
  const recognitionRef = useRef<any>(null);
  const translationQueue = useRef<string[]>([]);
  const processingQueue = useRef(false);
  const audioStreamerRef = useRef<AudioStreamer | null>(null);

  // Auto-scroll refs
  const transcriptRef = useRef<HTMLDivElement>(null);
  const translationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [finalTranscript]);

  useEffect(() => {
    if (translationRef.current) translationRef.current.scrollTop = translationRef.current.scrollHeight;
  }, [translations]);

  // Enumerate Devices on Mount
  useEffect(() => {
    enumerateAudioDevices();
    // Listen for device changes
    navigator.mediaDevices.addEventListener('devicechange', enumerateAudioDevices);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', enumerateAudioDevices);
    };
  }, []);

  // Update Output Device when selection changes
  useEffect(() => {
    if (audioStreamerRef.current && selectedOutputDeviceId) {
      audioStreamerRef.current.setOutputDevice(selectedOutputDeviceId);
    }
  }, [selectedOutputDeviceId]);

  const enumerateAudioDevices = async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        setStatus("Audio device enumeration not supported");
        return;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      
      const inputs = devices
        .filter(d => d.kind === 'audioinput')
        .map(d => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0,5)}` }));
      
      const outputs = devices
        .filter(d => d.kind === 'audiooutput')
        .map(d => ({ deviceId: d.deviceId, label: d.label || `Speaker ${d.deviceId.slice(0,5)}` }));

      setInputDevices(inputs);
      setOutputDevices(outputs);
    } catch (err) {
      console.error('Error enumerating devices:', err);
      setStatus("Error accessing audio devices");
    }
  };

  const initAudioStreamer = async () => {
    if (!audioStreamerRef.current) {
      // Need user interaction to resume/create context
      const ctx = await audioContext({ id: 'tts-out', sampleRate: 24000 });
      audioStreamerRef.current = new AudioStreamer(ctx);
      await audioStreamerRef.current.resume();
      
      // If a specific output is already selected, apply it
      if (selectedOutputDeviceId) {
        await audioStreamerRef.current.setOutputDevice(selectedOutputDeviceId);
      }
    }
  };

  const initRecognition = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert("Web Speech API is not supported in this browser.");
      return null;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = sourceLang;

    rec.onstart = () => {
      setIsRecognizing(true);
      setStatus("Listening...");
    };
    rec.onend = () => {
      setIsRecognizing(false);
      setStatus("Stopped. Click Start to resume.");
    };
    rec.onerror = (event: any) => {
      console.error("SpeechRecognition error:", event);
      // Robust error handling to avoid [object Object]
      let errCode = 'unknown';
      if (typeof event.error === 'string') {
        errCode = event.error;
      } else if (event.error && typeof event.error.message === 'string') {
        errCode = event.error.message;
      } else if (event.message) {
        errCode = event.message;
      }
      
      setStatus(`Speech error: ${errCode}`);
    };
    rec.onresult = (event: any) => {
      let finalChunk = "";
      let interim = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res[0].transcript;
        if (res.isFinal) {
          finalChunk += txt + " ";
        } else {
          interim += txt;
        }
      }

      if (finalChunk.trim().length > 0) {
        setFinalTranscript(prev => prev + finalChunk.trim() + "\n");
        enqueueTranslation(finalChunk.trim());
        setInterimTranscript("");
      } else {
        setInterimTranscript(interim);
      }
    };
    return rec;
  };

  const startRecording = async () => {
    await initAudioStreamer();
    
    if (!recognitionRef.current) {
      recognitionRef.current = initRecognition();
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.lang = sourceLang;
        recognitionRef.current.start();
      } catch (e: any) {
        console.error(e);
        setStatus("Error starting recognition: " + e.message);
      }
    }
  };

  const stopRecording = () => {
    if (recognitionRef.current && isRecognizing) {
      recognitionRef.current.stop();
    }
  };

  // --- Zoom Integration ---

  const fetchZoomTranscript = async () => {
    if (!zoomToken || !zoomMeetingId) {
      setStatus("Zoom: Missing Token or Meeting ID");
      return;
    }

    setIsFetchingZoom(true);
    setStatus("Zoom: Fetching recordings...");

    // Use a CORS proxy to bypass browser restrictions
    const CORS_PROXY = "https://corsproxy.io/?";

    try {
      // 1. Fetch recordings list
      const listUrl = `https://api.zoom.us/v2/meetings/${zoomMeetingId}/recordings`;
      
      const recResp = await fetch(`${CORS_PROXY}${encodeURIComponent(listUrl)}`, {
        headers: {
          'Authorization': `Bearer ${zoomToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!recResp.ok) {
        const err = await recResp.text();
        throw new Error(`Zoom API Error (${recResp.status}): ${err}`);
      }

      const recData = await recResp.json();
      const files = recData.recording_files || [];
      const transcriptFile = files.find((f: any) => f.file_type === 'TRANSCRIPT');

      if (!transcriptFile) {
        throw new Error("No transcript file found for this meeting.");
      }

      // 2. Fetch transcript content (VTT)
      setStatus("Zoom: Downloading transcript...");
      
      let downloadUrl = transcriptFile.download_url;
      const separator = downloadUrl.includes('?') ? '&' : '?';
      downloadUrl = `${downloadUrl}${separator}access_token=${zoomToken}`;

      const downResp = await fetch(`${CORS_PROXY}${encodeURIComponent(downloadUrl)}`);
      
      if (!downResp.ok) {
        throw new Error(`Failed to download transcript file (${downResp.status}).`);
      }

      const vttText = await downResp.text();
      
      // 3. Process VTT
      const cleanText = parseVTT(vttText);
      if (!cleanText) {
        setStatus("Zoom: Transcript was empty.");
        setIsFetchingZoom(false);
        return;
      }

      setStatus("Zoom: Processing transcript...");
      
      // 4. Update UI and Feed to Translation Queue
      setFinalTranscript(prev => prev + "\n[ZOOM TRANSCRIPT START]\n" + cleanText + "\n[ZOOM TRANSCRIPT END]\n");
      
      // Split into chunks for translation/TTS (sentence based approx)
      const sentences = cleanText.split(/(?<=[.!?])\s+/);
      
      await initAudioStreamer(); // Ensure audio is ready
      
      // Enqueue chunks with a slight delay
      sentences.forEach((sentence, index) => {
        if (sentence.trim()) {
          setTimeout(() => {
            enqueueTranslation(sentence.trim());
          }, index * 100); 
        }
      });

      setStatus("Zoom: Transcript loaded and queuing for translation.");

    } catch (e: any) {
      console.error(e);
      setStatus(`Zoom Error: ${e.message}`);
    } finally {
      setIsFetchingZoom(false);
    }
  };

  const parseVTT = (vtt: string): string => {
    const lines = vtt.split('\n');
    let output = [];
    
    for (const line of lines) {
      const trim = line.trim();
      if (!trim) continue;
      if (trim.startsWith('WEBVTT')) continue;
      if (trim.startsWith('NOTE')) continue;
      if (trim.includes('-->')) continue;
      if (/^\d+$/.test(trim)) continue;
      
      output.push(trim);
    }
    return output.join(' ');
  };


  // --- Translation Logic ---

  const enqueueTranslation = (text: string) => {
    if (!text) return;
    translationQueue.current.push(text);
    if (!processingQueue.current) {
      processQueue();
    }
  };

  const processQueue = async () => {
    if (processingQueue.current) return;
    processingQueue.current = true;

    while (translationQueue.current.length > 0) {
      const chunk = translationQueue.current.shift();
      if (chunk) {
        try {
          setStatus("Translating...");
          const translated = await translateWithGemini(chunk);
          if (translated) {
            setTranslations(prev => [...prev, { source: chunk, translated }]);
            setStatus("Speaking...");
            await speakWithGemini(translated);
          }
        } catch (err: any) {
          console.error("Process error", err);
          setStatus("Error: " + err.message);
        }
      }
    }

    setStatus("Idle");
    processingQueue.current = false;
  };

  const translateWithGemini = async (text: string) => {
    if (!apiKey) {
      setStatus("Missing Gemini API Key");
      return null;
    }
    
    const ai = new GoogleGenAI({ apiKey });
    const prompt = `You are a translation engine. Translate the user text below into ${getLanguageLabel(targetLang)}.
Rules:
1) Output ONLY the translation text.
2) No intro, no outro, no markdown.
3) Keep meaning precise.

User text:
"""${text}"""`;

    try {
      const response = await ai.models.generateContent({
        model: model, 
        contents: prompt
      });
      return response.text?.trim() || null;
    } catch (e: any) {
      console.error("Translation API error", e);
      throw e;
    }
  };

  // --- Gemini TTS (Audio Generation) Logic ---

  const speakWithGemini = async (text: string) => {
    if (!apiKey) return;

    const ai = new GoogleGenAI({ apiKey });
    const ttsModel = 'gemini-2.5-flash-preview-tts'; 
    
    try {
      const response = await ai.models.generateContent({
        model: ttsModel,
        contents: {
          parts: [{ text: text }]
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Puck' 
              }
            }
          }
        }
      });

      const parts = response.candidates?.[0]?.content?.parts;
      if (parts) {
        for (const part of parts) {
          if (part.inlineData && part.inlineData.mimeType.startsWith('audio')) {
             const buffer = base64ToArrayBuffer(part.inlineData.data);
             if (audioStreamerRef.current) {
               audioStreamerRef.current.addPCM16(new Uint8Array(buffer));
             }
          }
        }
      }

    } catch (e) {
      console.error("TTS Error", e);
    }
  };

  // --- Helpers ---

  const getLanguageLabel = (code: string) => {
     const map: Record<string, string> = {
        "en-US": "English",
        "tl-PH": "Filipino",
        "tr-TR": "Turkish",
        "nl-BE": "Dutch",
        "fr-FR": "French",
        "de-DE": "German",
        "es-ES": "Spanish"
      };
      return map[code] || code;
  };

  const handleLoadYt = () => {
    if (!ytUrl) return;
    try {
      let id = '';
      const u = new URL(ytUrl);
      if (u.hostname === "youtu.be") {
        id = u.pathname.slice(1);
      } else {
        id = u.searchParams.get("v") || '';
      }
      if (!id) {
        const m = ytUrl.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
        if (m) id = m[1];
      }
      if (id) {
        setYtEmbedUrl(`https://www.youtube.com/embed/${id}?rel=0`);
      }
    } catch (e) {}
  };

  return (
    <div className="app">
      <header>
        <h1>Live Transcription & Translation (Gemini Audio)</h1>
      </header>

      <main>
        {/* LEFT PANEL */}
        <section className="panel small">
          <h2>Controls & Source</h2>
          
          <div className="field-row">
            <label htmlFor="apiKey">Gemini API Key</label>
            <input 
              id="apiKey" 
              type="password" 
              placeholder="Gemini API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          <div className="field-row">
            <label htmlFor="model">Model</label>
            <input 
              id="model" 
              type="text" 
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Model name"
            />
          </div>

          <div className="field-row">
            <label htmlFor="sourceLang">Source</label>
            <select 
              id="sourceLang"
              value={sourceLang}
              onChange={(e) => setSourceLang(e.target.value)}
            >
              <option value="en-US">English</option>
              <option value="tl-PH">Filipino</option>
              <option value="tr-TR">Turkish</option>
              <option value="nl-BE">Dutch</option>
              <option value="fr-FR">French</option>
              <option value="de-DE">German</option>
              <option value="es-ES">Spanish</option>
            </select>
          </div>

          <div className="field-row">
            <label htmlFor="targetLang">Target</label>
            <select 
              id="targetLang"
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
            >
              <option value="en-US">English</option>
              <option value="tl-PH">Filipino</option>
              <option value="tr-TR">Turkish</option>
              <option value="nl-BE">Dutch</option>
              <option value="fr-FR">French</option>
              <option value="de-DE">German</option>
              <option value="es-ES">Spanish</option>
            </select>
          </div>

          {/* AUDIO INPUT SELECTOR (Visual for now as WebSpeech defaults to system, but kept for future expansion) */}
          <div className="subsection-title">Audio Input (Source)</div>
          <div className="audio-source-selector">
            <div 
              className={`audio-source-btn ${currentAudioSource === 'mic' ? 'active' : ''}`}
              onClick={() => setCurrentAudioSource('mic')}
            >
              Microphone
            </div>
            <div 
              className={`audio-source-btn ${currentAudioSource === 'device' ? 'active' : ''}`}
              onClick={() => setCurrentAudioSource('device')}
            >
              Device Audio
            </div>
          </div>

          <div className={`device-audio-container ${currentAudioSource === 'device' ? 'active' : ''}`}>
             <div className="field-row">
               <label htmlFor="inputDevice">Input Device</label>
               <select 
                 id="inputDevice"
                 value={selectedInputDeviceId}
                 onChange={(e) => setSelectedInputDeviceId(e.target.value)}
               >
                 <option value="">Default / Select...</option>
                 {inputDevices.map(d => (
                   <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                 ))}
               </select>
             </div>
          </div>

          {/* AUDIO OUTPUT SELECTOR (Speaker Separation) */}
          <div className="subsection-title">Speaker Output (TTS)</div>
          <div className="field-row">
            <label htmlFor="outputDevice">Output Device</label>
            <select 
              id="outputDevice"
              value={selectedOutputDeviceId}
              onChange={(e) => setSelectedOutputDeviceId(e.target.value)}
              disabled={outputDevices.length === 0}
            >
              <option value="">Default / Select...</option>
              {outputDevices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
              ))}
            </select>
          </div>
          {outputDevices.length === 0 && (
             <div style={{fontSize: '10px', color: '#656f92', marginTop: '-4px', marginBottom: '8px'}}>
               Note: Output selection requires HTTPS and browser support (Chrome/Edge).
             </div>
          )}

          <div className="subsection-title">Zoom Integration</div>
          <div className="field-row">
            <label htmlFor="zoomToken">Zoom Token</label>
            <input 
              id="zoomToken" 
              type="password" 
              placeholder="OAuth Token"
              value={zoomToken}
              onChange={(e) => setZoomToken(e.target.value)}
            />
          </div>
          <div className="field-row">
            <label htmlFor="zoomMeetingId">Meeting ID</label>
            <input 
              id="zoomMeetingId" 
              type="text" 
              placeholder="1234567890"
              value={zoomMeetingId}
              onChange={(e) => setZoomMeetingId(e.target.value)}
            />
          </div>
          <div className="field-row">
            <button 
              type="button" 
              onClick={fetchZoomTranscript} 
              disabled={isFetchingZoom}
            >
              {isFetchingZoom ? 'Fetching...' : 'Fetch & Process Transcript'}
            </button>
          </div>

          <div className="subsection-title">YouTube</div>
          <div className="field-row">
            <label htmlFor="ytUrl">URL</label>
            <input 
              id="ytUrl" 
              type="text" 
              placeholder="YouTube URL"
              value={ytUrl}
              onChange={(e) => setYtUrl(e.target.value)}
            />
            <button onClick={handleLoadYt} type="button">Load</button>
          </div>

          <div className="yt-wrapper">
            <iframe
              title="YouTube"
              src={ytEmbedUrl}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            >
            </iframe>
          </div>

          <div className="subsection-title">Action</div>
          <div className="field-row">
            <button 
              id="startBtn" 
              type="button" 
              onClick={startRecording}
              disabled={isRecognizing}
            >
              Start Mic
            </button>
            <button 
              id="stopBtn" 
              type="button" 
              onClick={stopRecording}
              disabled={!isRecognizing}
            >
              Stop Mic
            </button>
          </div>

          <div className="status">{status}</div>
        </section>

        {/* RIGHT PANEL */}
        <section className="panel large">
          <h2>Live Transcript & Translation</h2>
          
          <div className="transcript-container">
            <div>
              <div className="subsection-title">Final Transcript</div>
              <div ref={transcriptRef} className="transcript-block">
                {finalTranscript}
              </div>
            </div>

            <div>
              <div className="subsection-title">Interim</div>
              <div className="transcript-block interim">
                {interimTranscript}
              </div>
            </div>
          </div>

          <div className="subsection-title" style={{ marginTop: 10 }}>
            Translated Output (Gemini Audio)
          </div>
          <div ref={translationRef} className="translations">
            {translations.map((item, idx) => (
              <div key={idx} className="translation-item">
                <div className="translation-label">→ {getLanguageLabel(targetLang)}</div>
                <div className="translation-text">{item.translated}</div>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer>
        <span>Live transcription and translation tool powered by Google Gemini</span>
      </footer>
    </div>
  );
}

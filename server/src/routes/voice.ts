import { Router } from "express";
import axios from "axios";
import { elevenLabsGuard } from "../guards.js";
import { runtimeConfig } from "../runtimeConfig.js";
import { metrics } from "../metrics.js";

const router = Router();

// ElevenLabs 무료 플랜이 월 1만 자라, 긴 답변은 앞부분만 읽는다
const MAX_TTS_LENGTH = 600;

// ElevenLabs 기본 제공 음성(Rachel). 다국어 모델이라 한국어도 읽는다.
// 다른 음성을 쓰려면 .env의 ELEVENLABS_VOICE_ID로 바꾼다.
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

router.post("/", async (req, res) => {
  const text = (req.body?.text || "").trim();
  if (!text) {
    return res.status(400).json({ error: "읽을 텍스트가 없습니다." });
  }

  // Graceful Degradation: 음성 합성은 가장 무겁고(외부 호출 + 오디오 전송) 가장 덜
  // 핵심적인 기능이라, 과부하 시 제일 먼저 포기한다. 프론트는 503을 받으면 브라우저
  // 내장 음성으로 폴백하므로 사용자 경험이 완전히 끊기지는 않는다.
  if (runtimeConfig.degradation !== "none") {
    metrics.inc("degradation.ttsSkipped");
    return res.status(503).json({ error: "지금은 음성 합성을 잠시 중단했어요." });
  }

  // 키가 없으면 503을 주고, 프론트가 브라우저 내장 음성으로 폴백한다
  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: "서버에 ELEVENLABS_API_KEY가 없습니다." });
  }

  // [1] 같은 출처 번호는 소리 내어 읽으면 어색해서 빼고 보낸다
  const speakable = text.replace(/\s*\[\d+\]/g, "").slice(0, MAX_TTS_LENGTH);
  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;

  try {
    const { data } = await elevenLabsGuard.call(() =>
      axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        { text: speakable, model_id: "eleven_multilingual_v2" },
        {
          headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
          responseType: "arraybuffer",
          timeout: 30000,
        }
      )
    );
    res.set("Content-Type", "audio/mpeg").send(Buffer.from(data));
  } catch (e) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    console.error("voice error:", status ?? "", e instanceof Error ? e.message : e);
    // 키 오류든 한도 초과든 프론트 입장에선 폴백하면 되는 상황이라 503 하나로 보낸다
    res.status(503).json({ error: "음성 생성에 실패했습니다." });
  }
});

export default router;

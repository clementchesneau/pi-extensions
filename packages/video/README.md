# Video

Lets the agent understand a video from a URL or a local file. It reads the transcript, the
metadata and frames taken at scene changes, then looks closer at the moments that matter. The
agent's own model does the watching; an optional tool asks Google Gemini about a whole video,
image and sound together.

```sh
pi install npm:@clement_chsn/pi-video
brew install yt-dlp ffmpeg
```

yt-dlp downloads from YouTube, TikTok, Instagram, X and the other sites it supports; Homebrew
also installs deno, which yt-dlp needs for YouTube. ffmpeg reads local files and extracts frames.
On Linux, install both with your package manager or from their sites. Nothing is installed
behind your back: a missing program is reported with the command to install it.

## What the agent gets

| Tool | Purpose |
| --- | --- |
| `video_overview` | Metadata, chapters, a timestamped transcript and about 8 frames at scene changes, 768 px wide; `from`/`to` narrow it to one part |
| `video_frames` | Frames at up to 12 precise moments, 1280 px wide, from the session's copy of the video |
| `video_ask` | A question to Gemini about the video, image and sound together; only offered when a Gemini key is configured |

Frames need a model that accepts images; a text-only model gets the transcript and metadata.

## Transcripts with whisper.cpp

The transcript comes from the platform's subtitles when it has them: manual subtitles first,
otherwise the automatic captions of the original audio. Without subtitles, and for local files,
whisper.cpp transcribes the audio locally if you install it and choose a model:

```sh
brew install whisper.cpp
mkdir -p ~/.local/share/whisper
curl -L -o ~/.local/share/whisper/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

Then add the model's path to `~/.config/pi-extensions/.env`, the private file the web extension
also uses (create it with `chmod 600`):

```dotenv
WHISPER_MODEL=/Users/you/.local/share/whisper/ggml-large-v3-turbo-q5_0.bin
```

This 547 MiB model transcribes about 50 times faster than real time on Apple Silicon. The 142 MiB
`ggml-base.bin` is smaller and makes more mistakes. Without a model, the overview says that it has
no transcript.

## Gemini

`video_ask` sends the video to Google, so Gemini can answer about what the transcript and frames
miss: music, sound, motion, gestures, or a long video as a whole. Add a key from
[Google AI Studio](https://aistudio.google.com/apikey) to the same file, then `/reload`:

```dotenv
GEMINI_API_KEY=your_gemini_key
# Optional; this is the default:
GEMINI_VIDEO_MODEL=gemini-3.5-flash-lite
```

- A YouTube URL is passed to Gemini as is. Any other video, downloaded or local, is re-encoded as
  a small MP4 (H.264, 720p at most, no metadata such as location), cut exactly to `from`/`to` when
  given, uploaded through the Gemini Files API, and deleted once Gemini has answered, even if you
  press Esc. If the deletion fails, the answer says so; Gemini deletes uploads after 48 hours
  anyway. For an uploaded part, Gemini's times start at the part. Re-encoding needs an ffmpeg
  built with libx264, as Homebrew's is.
- Videos over 200 MB need `from`/`to`: only that part is cut and sent.
- Costs depend on your Gemini account; with the default model, about $0.02 per 10 minutes of
  video. On the free tier, Google may use what you send to improve its products, except in the
  EEA, Switzerland and the UK.

## Behavior and limits

- **Downloads** are at most 480 pixels high, or the smallest format a site offers. yt-dlp runs
  without your yt-dlp configuration and never uses browser cookies, so videos that require
  logging in fail with an explanation: Instagram often does, Vimeo always does. Sites change
  often; when an extractor fails, `brew upgrade yt-dlp` usually fixes it.
- **Long videos**: over 30 minutes, the overview uses subtitles only and frames evenly spaced
  through the stream, without downloading. Passing `from`/`to` downloads that part, finds its
  scene changes and, when the video has no subtitles, transcribes it with whisper. Reaching a part deep into a long YouTube video is slow on YouTube's side: about
  45 seconds for a one-minute part an hour into a lecture, against a few seconds for a short video.
- **Sources**: one video per call. Playlists, channels and live streams are refused. A local path
  is relative to the working directory and may start with `~` or `@`, as in Pi's own tools;
  pictures, text and audio-only files are refused.
- **Time limits**: each yt-dlp or ffmpeg run stops after 10 minutes and each whisper run after 30
  minutes. Gemini gets 5 minutes to process an upload.
- **Network**: URLs follow the web extension's rules: public HTTP(S) hosts only, no credentials
  or explicit ports. yt-dlp then follows the media links a page points to by itself; their hosts
  are not checked. ffmpeg reads local inputs as files only.
- **Files**: downloads, audio, frames and long texts go to a private `pi-video-*` temporary
  directory, removed when the session ends. At the next start, the directories that your crashed
  sessions left are removed too; nothing else is touched. Text output is capped at 24 KB or 600 lines, with the complete text saved
  there.
- **Cancellation**: Esc stops yt-dlp, ffmpeg and whisper with all their processes.
- **Trust**: titles, descriptions, transcripts and on-screen text are untrusted data. The agent is
  told not to follow instructions found in them, but this is no guarantee against prompt
  injection.

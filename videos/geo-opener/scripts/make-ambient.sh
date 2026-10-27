#!/usr/bin/env bash
# Bespoke 10s ambient bed for the GeoCiteOps opener.
# Fully synthesized locally with FFmpeg — no external assets, no license issues.
# D-centred harmonic field: open Dsus2 pad resolving into Dmaj9 shimmer,
# with soft citation chimes on the visual beats.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p assets/audio

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "aevalsrc='0.10*sin(2*PI*73.42*t)*min(t/2.5,1)*min(max((10-t)/2,0),1)':s=48000:d=10" \
  -f lavfi -i "aevalsrc='(0.050*sin(2*PI*146.83*t)+0.045*sin(2*PI*220*t)+0.035*sin(2*PI*329.63*t))*(0.75+0.25*sin(2*PI*0.09*t))*min(max((t-0.8)/2,0),1)*min(max((7.0-t)/2,0),1)':s=48000:d=10" \
  -f lavfi -i "aevalsrc='(0.045*sin(2*PI*146.83*t)+0.035*sin(2*PI*369.99*t)+0.030*sin(2*PI*440*t))*(0.75+0.25*sin(2*PI*0.07*t+1.2))*min(max((t-4.2)/1.8,0),1)*min(max((10-t)/2,0),1)':s=48000:d=10" \
  -f lavfi -i "aevalsrc='0.012*sin(2*PI*1174.66*t)*(0.6+0.4*sin(2*PI*0.35*t))*min(max((t-2.5)/2,0),1)*min(max((10-t)/2,0),1)':s=48000:d=10" \
  -f lavfi -i "anoisesrc=color=pink:sample_rate=48000:duration=10:amplitude=0.014,highpass=f=350,lowpass=f=6000,afade=t=in:st=0:d=1.5,afade=t=out:st=8.5:d=1.5" \
  -f lavfi -i "aevalsrc='0.05*min(max((t-0.55)/0.04,0),1)*exp(-max(t-0.55,0)*2.2)*(sin(2*PI*880*max(t-0.55,0))+0.5*sin(2*PI*1318.51*max(t-0.55,0)))+0.045*min(max((t-2.8)/0.04,0),1)*exp(-max(t-2.8,0)*2.5)*(sin(2*PI*1174.66*max(t-2.8,0))+0.5*sin(2*PI*880*max(t-2.8,0)))+0.03*min(max((t-7.9)/0.05,0),1)*exp(-max(t-7.9,0)*1.8)*(sin(2*PI*587.33*max(t-7.9,0))+0.4*sin(2*PI*880*max(t-7.9,0)))':s=48000:d=10" \
  -filter_complex "[0:a][1:a][2:a][3:a][4:a][5:a]amix=inputs=6:normalize=0[mix];[mix]pan=stereo|c0=c0|c1=c0,stereowiden=delay=18:feedback=0.25:crossfeed=0.25:drymix=0.85,aecho=0.8:0.65:90|150:0.18|0.10,loudnorm=I=-18:TP=-3:LRA=7,aresample=48000,alimiter=limit=0.95[aout]" \
  -map "[aout]" -ac 2 -ar 48000 -c:a pcm_s16le assets/audio/ambient-bed.wav

ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 assets/audio/ambient-bed.wav

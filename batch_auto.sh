#!/usr/bin/env bash
# ============================================================
#  🎵  SoundVault Batch Automator (macOS Compatible)
#  Interactive prompt for batching download_and_stem.sh
# ============================================================

# Arrays to hold our data
urls=()
albums=()

# Colours
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}${CYAN}══════════════════════════════════════════${NC}"
echo -e "${BOLD}${CYAN}  🎵 SoundVault Batch Automator${NC}"
echo -e "${BOLD}${CYAN}══════════════════════════════════════════${NC}"
echo ""

# Tell macOS Bash to ignore uppercase/lowercase for string comparisons
shopt -s nocasematch

# ── 1. Interactive Collection Phase ─────────────────────────
while true; do
    # Ask for Link
    read -r -p "▶ Paste YouTube/Playlist Link (or type 'done' to run): " link
    
    # If user typed 'done', break out of the loop
    if [[ "$link" == "done" ]]; then
        break
    fi
    
    # Skip empty lines if user accidentally presses enter
    if [[ -z "$link" ]]; then
        continue
    fi
    
    # Ask for Album Name
    read -r -p "  Name the playlist/album (Press Enter for '_Unsorted'): " album
    
    # Apply default if left blank
    if [[ -z "$album" ]]; then
        album="_Unsorted"
    fi
    
    # Save to arrays
    urls+=("$link")
    albums+=("$album")
    
    echo -e "  ${GREEN}✓ Added:${NC} '$album'"
    echo ""
    
    # Ask if they want to add more
    read -r -p "Add another link? [Y/n/done]: " choice
    if [[ "$choice" == "n" || "$choice" == "done" ]]; then
        break
    fi
    echo ""
done

# Turn case sensitivity back on just to be safe
shopt -u nocasematch

# ── 2. Pre-flight Checks ────────────────────────────────────
total=${#urls[@]}

if (( total == 0 )); then
    echo -e "\n${YELLOW}No links provided. Exiting.${NC}"
    exit 0
fi

if [[ ! -x "./download_and_stem.sh" ]]; then
    echo -e "\n${YELLOW}[WARN] Cannot find executable ./download_and_stem.sh in this folder.${NC}"
    echo "Make sure you are running this in the same folder as your main scripts."
    exit 1
fi

# ── 3. Execution & Progress Bar ─────────────────────────────
LOG_FILE="batch_dl_log.txt"
> "$LOG_FILE" # Clear previous log

echo -e "\n${BOLD}Starting batch download of $total item(s)...${NC}"
echo -e "(Detailed background logs are being saved to ${CYAN}$LOG_FILE${NC})\n"

# Function to draw a visual progress bar
draw_bar() {
    local current=$1
    local total=$2
    local width=30
    local filled=0
    
    if (( total > 0 )); then
        filled=$(( current * width / total ))
    fi
    local empty=$(( width - filled ))
    
    # Print the bar using carriage return \r so it overwrites the current line
    printf "\r${CYAN}Progress:${NC} ["
    for ((i=0; i<filled; i++)); do printf "█"; done
    for ((i=0; i<empty; i++)); do printf "░"; done
    printf "] %d/%d " "$current" "$total"
}

# Initial empty progress bar (0/XX)
draw_bar 0 "$total"

for i in "${!urls[@]}"; do
    # Append to log file to see what is currently processing
    echo "=========================================" >> "$LOG_FILE"
    echo "PROCESSING: ${albums[$i]}" >> "$LOG_FILE"
    echo "URL: ${urls[$i]}" >> "$LOG_FILE"
    echo "=========================================" >> "$LOG_FILE"

    # Run your command, send all stdout & stderr to the log file
    ./download_and_stem.sh --album "${urls[$i]}" "${albums[$i]}" >> "$LOG_FILE" 2>&1
    
    # Update progress bar
    current=$((i + 1))
    draw_bar "$current" "$total"
done

echo -e "\n\n${GREEN}✅ All downloads completed successfully!${NC}"
#!/bin/bash
# Скрипт первоначальной настройки бота на Ubuntu-сервере (Oracle Cloud / любой VPS)
# Запускать от имени пользователя ubuntu: bash setup.sh

set -e

echo "=== Установка зависимостей ==="
sudo apt update && sudo apt upgrade -y
sudo apt install -y python3 python3-pip python3-venv

echo "=== Создание директории проекта ==="
mkdir -p ~/telegram-bot
cd ~/telegram-bot

echo "=== Копирование файлов проекта ==="
# Если файлы уже загружены через scp/git — этот шаг можно пропустить

echo "=== Создание виртуального окружения ==="
python3 -m venv venv
source venv/bin/activate

echo "=== Установка Python-зависимостей ==="
pip install --upgrade pip
pip install -r requirements.txt

echo "=== Создание .env файла ==="
if [ ! -f .env ]; then
    cp .env.example .env
    echo ""
    echo ">>> ОТКРОЙТЕ .env И ВСТАВЬТЕ ВАШИ ЗНАЧЕНИЯ:"
    echo ">>> nano ~/telegram-bot/.env"
    echo ""
fi

echo "=== Установка systemd-сервиса ==="
sudo cp deploy/telegram-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable telegram-bot
sudo systemctl start telegram-bot

echo "=== Бот запущен! ==="
echo "Статус: sudo systemctl status telegram-bot"
echo "Логи:   sudo journalctl -u telegram-bot -f"
echo "Перезапуск: sudo systemctl restart telegram-bot"

#!/usr/bin/env python3
"""Скрипт для записи bot.py с правильной кодировкой."""
import pathlib

BOT_PY = r'''"""
Telegram-bot avtomaticheskogo odobreniya zayavok na vstuplenie v kanal.

Ispolzuet aiogram 3.x i long polling.
Poluchaet ChatJoinRequest - avtomaticheski odobryaet i otpravlyaet
privetstvennoe soobshchenie v lichnye soobshcheniya polzovatelya.
"""

import asyncio
import io
import logging
import os
import sys

from aiogram import Bot, Dispatcher, Router
from aiogram.exceptions import (
    TelegramBadRequest,
    TelegramForbiddenError,
    TelegramNetworkError,
)
from aiogram.filters import Command
from aiogram.types import (
    ChatJoinRequest,
    ChatMemberUpdated,
    Message,
)
from dotenv import load_dotenv

# ===========================================================================
# 1. LOGIROVANIE - nastrojka DO lyubykh proverok
# ===========================================================================

_stream = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=_stream,
)
logger = logging.getLogger(__name__)

# ===========================================================================
# 2. PEREMENNYE OKRUZHENIYA
# ===========================================================================

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_ID = os.getenv("ADMIN_ID")
CHANNEL_ID = os.getenv("CHANNEL_ID")

if not BOT_TOKEN:
    logger.critical(
        "BOT_TOKEN ne zadan. Sozdayte fail .env i ukazhite BOT_TOKEN."
    )
    sys.exit(1)

if not ADMIN_ID:
    logger.warning(
        "ADMIN_ID ne zadan. Admin-komandy budut nedostupny."
    )
else:
    ADMIN_ID = int(ADMIN_ID)

if not CHANNEL_ID:
    logger.critical(
        "CHANNEL_ID ne zadan. Ukazhite ID kanala."
    )
    sys.exit(1)

CHANNEL_ID = int(CHANNEL_ID)

# ===========================================================================
# 3. INICIALIZACIYA
# ===========================================================================

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()
router = Router()

_processed_requests = set()

# ===========================================================================
# 4. ADMIN-KOMANDY
# ===========================================================================


@router.message(Command("status"))
async def cmd_status(message: Message) -> None:
    """ /status - proverka rabotosposobnosti bota (tolko admin). """
    if not ADMIN_ID or message.from_user.id != ADMIN_ID:
        return

    text = (
        f"Bot zapushchen i rabotaet\\n\\n"
        f"ID kanala: {CHANNEL_ID}\\n"
        f"Rezhim: avtomaticheskoye odobreniye zayavok\\n"
        f"Obrabotano za sessiyu: {len(_processed_requests)}"
    )
    await message.answer(text)
    logger.info("Komanda /status ot administratora %s", message.from_user.id)


@router.message(Command("chat_id"))
async def cmd_chat_id(message: Message) -> None:
    """ /chat_id - pokazyvayet ID tekushchego chata (tolko admin). """
    if not ADMIN_ID or message.from_user.id != ADMIN_ID:
        return

    chat_id = message.chat.id
    chat_type = message.chat.type
    chat_title = message.chat.title or message.chat.full_name or "LS"

    text = (
        f"Info o chate:\\n"
        f"ID chata: {chat_id}\\n"
        f"Tip: {chat_type}\\n"
        f"Nazvanie: {chat_title}"
    )
    await message.answer(text)
    logger.info(
        "Komanda /chat_id — chat_id=%s, tip=%s", chat_id, chat_type,
    )


@router.message(Command("approve_pending"))
async def cmd_approve_pending(message: Message) -> None:
    """
    /approve_pending user_id1 [user_id2 ...]
    
    Obrabatyvaet starye zayavki po ukazannym ID.
    Telegram API NE pozvolyayet poluchit' spisok zayavok, poetomu
    nuzhno ukazat' user_id yavno.
    """
    if not ADMIN_ID or message.from_user.id != ADMIN_ID:
        return

    parts = message.text.split()
    if len(parts) < 2:
        await message.answer(
            "Ispolzovanie: /approve_pending user_id1 [user_id2 ...]\\n"
            "Primer: /approve_pending 123456789\\n\\n"
            "Telegram Bot API ne pozvolyayet poluchit' spisok zayavok, "
            "poetomu nuzhno ukazat' ID polzateley yavno."
        )
        return

    approved = 0
    failed = 0

    for arg in parts[1:]:
        try:
            uid = int(arg)
        except ValueError:
            await message.answer(f"'{arg}' ne yavlyaetsya validnym ID.")
            continue

        try:
            await bot.approve_chat_join_request(
                chat_id=CHANNEL_ID,
                user_id=uid,
            )
            approved += 1
            _processed_requests.add(uid)
            logger.info("Zayavka ID: %s odobrena /approve_pending", uid)

            try:
                await bot.send_message(
                    chat_id=uid,
                    text="Privet! Rad videt' tebya v kanale. Tvoya zayavka odobrena!",
                )
            except Exception as send_err:
                logger.warning(
                    "Ne udalos' otpravit' LS ID: %s: %s", uid, send_err,
                )

        except TelegramBadRequest as e:
            failed += 1
            logger.error("TelegramBadRequest pri odobrenii ID: %s: %s", uid, e)
        except TelegramForbiddenError as e:
            failed += 1
            logger.error("TelegramForbiddenError ID: %s: %s", uid, e)
        except Exception as e:
            failed += 1
            logger.error("Oshibka pri odobrenii ID: %s: %s", uid, e)

    await message.answer(
        f"Rezultat:\\n  Odobreno: {approved}\\n  Oshibok: {failed}"
    )


# ===========================================================================
# 5. OBRABOTCHIK ChatJoinRequest - GLAVNAYA LOGIKA
# ===========================================================================


@router.chat_join_request()
async def handle_chat_join_request(event: ChatJoinRequest) -> None:
    """
    Obrabatyvaet kazhduyu vkhodyashchuyu zayavku na vstuplenie v kanal.

    1. Proveryaem chat.id kanala
    - Proveryaem dubli
    - Odobryaem zayavku
    - Otpravlyayem uvedomleniye v LS
    - Oshibka otpravki NE otmenyaet odobrenie
    """

    user_id = event.from_user.id
    username = event.from_user.username or "bez_nika"
    user_full_name = event.from_user.full_name or "Bez imeni"

    if event.chat.id != CHANNEL_ID:
        logger.warning(
            "Zayavka v drugoy kanal (chat_id=%s), ozhidalsya %s. Propusk.",
            event.chat.id, CHANNEL_ID,
        )
        return

    if user_id in _processed_requests:
        logger.info(
            "Zayavka ID: %s uzhe obrabotana. Propusk.", user_id,
        )
        return

    logger.info(
        "Novaya zayavka: %s (ID: %s, @%s)",
        user_full_name, user_id, username,
    )

    try:
        await bot.approve_chat_join_request(
            chat_id=event.chat.id,
            user_id=user_id,
        )
        _processed_requests.add(user_id)
        logger.info(
            "Zayavka %s (ID: %s) ODOBRENA.",
            user_full_name, user_id,
        )
    except TelegramBadRequest as e:
        logger.error(
            "TelegramBadRequest pri odobrenii %s (ID: %s): %s",
            user_full_name, user_id, e,
        )
        return
    except TelegramForbiddenError as e:
        logger.error(
            "TelegramForbiddenError — bot ne imeyet prav. "
            "Prover'te can_invite_users: %s", e,
        )
        return
    except TelegramNetworkError as e:
        logger.error(
            "Setevaya oshibka %s (ID: %s): %s",
            user_full_name, user_id, e,
        )
        return
    except Exception as e:
        logger.error(
            "Nepredvidennaya oshibka %s (ID: %s): %s",
            user_full_name, user_id, e,
        )
        return

    try:
        await bot.send_message(
            chat_id=user_id,
            text="Privet! Rad videt' tebya v kanale. Tvoya zayavka odobrena!",
        )
        logger.info(
            "Uvedomlenie otpravleno %s (ID: %s).",
            user_full_name, user_id,
        )
    except TelegramForbiddenError:
        logger.warning(
            "Ne udalos' otpravit' LS %s (ID: %s) — blokirovka. "
            "Zayavka uzhe odobrena.",
            user_full_name, user_id,
        )
    except TelegramBadRequest as e:
        logger.warning(
            "TelegramBadRequest LS %s (ID: %s): %s. Zayavka uzhe odobrena.",
            user_full_name, user_id, e,
        )
    except TelegramNetworkError as e:
        logger.warning(
            "Setevaya oshibka LS %s (ID: %s): %s. Zayavka uzhe odobrena.",
            user_full_name, user_id, e,
        )
    except Exception as e:
        logger.warning(
            "Nepredvidennaya oshibka LS %s (ID: %s): %s. Zayavka uzhe odobrena.",
            user_full_name, user_id, e,
        )


# ===========================================================================
# 6. LOGIROVANIE IZMENENIYA STATUSA BOTA V CHATE
# ===========================================================================


@router.my_chat_member()
async def handle_bot_chat_member(event: ChatMemberUpdated) -> None:
    """Logiruyem dobavlenie/udalenie bota iz kanala/gruppy."""
    chat = event.chat
    new_status = event.new_chat_member.status
    old_status = event.old_chat_member.status
    logger.info(
        "Status bota v chate '%s' (ID: %s): %s -> %s",
        chat.title, chat.id, old_status, new_status,
    )


# ===========================================================================
# 7. TOCHKA VKHODA
# ===========================================================================


async def main() -> None:
    """Glavnaya funksiya: webhook drop, router, long polling."""

    bot_info = await bot.get_me()
    logger.info("Bot: @%s (ID: %s)", bot_info.username, bot_info.id)
    logger.info("ID kanala: %s", CHANNEL_ID)
    if ADMIN_ID:
        logger.info("ID administratora: %s", ADMIN_ID)

    try:
        bot_member = await bot.get_chat_member(
            chat_id=CHANNEL_ID,
            user_id=bot_info.id,
        )
        logger.info(
            "Prava bota: status=%s, can_invite_users=%s, can_manage_chat=%s",
            bot_member.status,
            getattr(bot_member, "can_invite_users", "N/A"),
            getattr(bot_member, "can_manage_chat", "N/A"),
        )
    except Exception as e:
        logger.error(
            "Ne udalos' proverit' prava bota v kanale %s: %s",
            CHANNEL_ID, e,
        )

    await bot.delete_webhook(drop_pending_updates=True)
    dp.include_router(router)

    try:
        await dp.start_polling(
            bot,
            allowed_updates=["message", "chat_join_request"],
        )
    except KeyboardInterrupt:
        logger.info("Bot ostanovlen.")
    finally:
        await bot.session.close()
        logger.info("Sessiya zakryta.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Bot ostanovlen.")
    except Exception as e:
        logger.critical("Kriticheskaya oshibka: %s", e, exc_info=True)
        sys.exit(1)
'''

pathlib.Path(__file__).parent.joinpath('bot.py').write_text(BOT_PY, encoding='utf-8')
print('bot.py zapisan')

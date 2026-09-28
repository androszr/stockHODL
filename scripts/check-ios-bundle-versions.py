#!/usr/bin/env python3
"""Refuse an exported app whose build number is not the one this run chose.

The TestFlight workflow computes one build number (scripts/ios-build-number.py)
and passes it to the archive as CURRENT_PROJECT_VERSION. This reads it back out
of the bytes about to be uploaded — the unpacked `.ipa` — rather than trusting
that the override reached every target. App Store Connect wants the app and
its embedded widget extension to agree on both numbers; a widget still saying
build 1 is rejected at upload or, worse, processed and then refused on device.

Checks, all of which must hold:
  * `<App>.app/Info.plist` parses, and its CFBundleVersion is the expected
    build number and its CFBundleShortVersionString is present;
  * `PlugIns/` holds exactly one WidgetKit extension, and it is the expected
    one (`StockHODLWidgets.appex` unless `--widget` says otherwise), with an
    identifier under the app's own;
  * the widget's CFBundleVersion and CFBundleShortVersionString equal the
    app's.

    scripts/check-ios-bundle-versions.py --app Payload/StockHODL.app --build-number 30

Exit codes: 0 consistent, 1 refused (every problem is printed), 2 usage.
"""

from __future__ import annotations

import argparse
import os
import plistlib
import sys

WIDGET_POINT = 'com.apple.widgetkit-extension'
DEFAULT_WIDGET = 'StockHODLWidgets.appex'


def load(path: str, problems: list[str]) -> dict | None:
    try:
        with open(path, 'rb') as handle:
            data = plistlib.load(handle)
    except FileNotFoundError:
        problems.append(f'{path} is missing')
        return None
    except Exception as error:  # plistlib raises several unrelated types
        problems.append(f'{path} is not a readable plist ({type(error).__name__}: {error})')
        return None
    if not isinstance(data, dict):
        problems.append(f'{path} is not a dictionary plist')
        return None
    return data


def text(info: dict, key: str, where: str, problems: list[str]) -> str | None:
    value = info.get(key)
    if not isinstance(value, str) or value.strip() == '':
        problems.append(f'{where} has no {key}')
        return None
    return value


def widget_point(info: dict) -> str | None:
    extension = info.get('NSExtension')
    if isinstance(extension, dict):
        point = extension.get('NSExtensionPointIdentifier')
        if isinstance(point, str):
            return point
    return None


def check(app: str, build: str, widget_name: str) -> list[str]:
    problems: list[str] = []
    app_info = load(os.path.join(app, 'Info.plist'), problems)
    if app_info is None:
        return problems
    app_build = text(app_info, 'CFBundleVersion', 'the app', problems)
    app_version = text(app_info, 'CFBundleShortVersionString', 'the app', problems)
    app_id = text(app_info, 'CFBundleIdentifier', 'the app', problems)
    if app_build is not None and app_build != build:
        problems.append(f'the app says build {app_build}, this run chose {build}')

    plugins = os.path.join(app, 'PlugIns')
    appexes = sorted(n for n in os.listdir(plugins) if n.endswith('.appex')) if os.path.isdir(plugins) else []
    widgets: list[tuple[str, dict]] = []
    for name in appexes:
        info = load(os.path.join(plugins, name, 'Info.plist'), problems)
        if info is not None and widget_point(info) == WIDGET_POINT:
            widgets.append((name, info))
    if len(widgets) != 1:
        found = ', '.join(name for name, _ in widgets) or 'none'
        problems.append(f'expected exactly one widget extension ({widget_name}); found {found}')
        return problems
    name, info = widgets[0]
    if name != widget_name:
        problems.append(f'the widget extension is {name}, expected {widget_name}')
        return problems

    where = f'the widget ({name})'
    widget_build = text(info, 'CFBundleVersion', where, problems)
    widget_version = text(info, 'CFBundleShortVersionString', where, problems)
    widget_id = text(info, 'CFBundleIdentifier', where, problems)
    if widget_build is not None and widget_build != build:
        problems.append(f'{where} says build {widget_build}, this run chose {build}')
    if app_version is not None and widget_version is not None and widget_version != app_version:
        problems.append(f'{where} says version {widget_version}, the app says {app_version}')
    if app_id is not None and widget_id is not None and not widget_id.startswith(app_id + '.'):
        problems.append(f'{where} is {widget_id}, which is not under the app identifier {app_id}')
    return problems


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    parser.add_argument('--app', required=True, help='path to the unpacked <App>.app')
    parser.add_argument('--build-number', required=True)
    parser.add_argument('--widget', default=DEFAULT_WIDGET)
    args = parser.parse_args(argv)
    if not os.path.isdir(args.app):
        print(f'check-ios-bundle-versions: {args.app} is not an app bundle folder', file=sys.stderr)
        return 1
    problems = check(args.app, args.build_number, args.widget)
    if problems:
        for problem in problems:
            print(f'check-ios-bundle-versions: {problem}', file=sys.stderr)
        return 1
    print(f'check-ios-bundle-versions: app and widget are build {args.build_number}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
